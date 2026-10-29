package downloader

import (
	"fmt"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zenon-network/go-zenon/chain/nom"
	"github.com/zenon-network/go-zenon/common/types"
)

// This orders the real prior block-fetch error ahead of its EOF consumption.
// Both complete synchronizations use the actual queue, peers and deliveries.
// It does not establish the cause of a historical native-node failure.
func TestSynchroniseDoesNotReusePreviousHashCompletion(t *testing.T) {
	var height atomic.Uint64
	height.Store(5)
	hashes := make(map[types.Hash]uint64)
	for h := uint64(1); h <= 7; h++ {
		hashes[testHash('s', h)] = h
	}
	d := New(
		func(hash types.Hash) bool { h, ok := hashes[hash]; return ok && h <= height.Load() },
		func(hash types.Hash) *nom.DetailedMomentum {
			h, ok := hashes[hash]
			if !ok || h > height.Load() {
				return nil
			}
			return &nom.DetailedMomentum{Momentum: &nom.Momentum{Height: h, Hash: hash}}
		},
		func() *nom.Momentum { h := height.Load(); return &nom.Momentum{Height: h, Hash: testHash('s', h)} },
		func(blocks []*nom.DetailedMomentum) (int, error) {
			for i, block := range blocks {
				if block.Momentum.Height != height.Load()+1 || block.Momentum.Hash != testHash('s', block.Momentum.Height) {
					t.Errorf("unexpected imported momentum at index %d", i)
				}
				height.Store(block.Momentum.Height)
			}
			return 0, nil
		},
		func(string) {},
	)
	releasePreviousEOF := make(chan struct{})
	setupFailure := make(chan error, 1)
	waitFor := func(predicate func() bool) error {
		deadline := time.Now().Add(time.Second)
		for !predicate() {
			if time.Now().After(deadline) {
				return fmt.Errorf("controlled prior-phase ordering timed out")
			}
			runtime.Gosched()
		}
		return nil
	}
	oldPeer := newPeer("previous-peer", eth61, testHash('s', 6), nil, nil, nil)
	oldPeer.getAbsHashes = func(from uint64, count int) error {
		if from == 7 {
			<-releasePreviousEOF
		}
		return d.DeliverHashes(oldPeer.id, peerReply(6, func(h uint64) types.Hash { return testHash('s', h) }, from, count))
	}
	oldPeer.getBlocks = func(requested []types.Hash) error {
		// Let the request-scheduling pass finish before holding its real queue
		// lock. The block worker then waits in Deliver while EOF is admitted.
		time.Sleep(10 * time.Millisecond)
		d.queue.lock.Lock()
		defer d.queue.lock.Unlock()
		err := d.DeliverBlocks(oldPeer.id, []*nom.DetailedMomentum{{Momentum: &nom.Momentum{Height: 5000, Hash: requested[0]}}})
		if err == nil {
			err = waitFor(func() bool { return len(d.blockCh) == 0 })
		}
		close(releasePreviousEOF)
		if err == nil {
			err = waitFor(func() bool { return len(d.processCh) == 1 })
		}
		if err != nil {
			setupFailure <- err
		}
		return err
	}
	if err := d.peers.Register(oldPeer); err != nil {
		t.Fatal(err)
	}
	oldDone := make(chan error, 1)
	go func() { oldDone <- d.synchronise(oldPeer.id, oldPeer.head, 6) }()
	select {
	case err := <-oldDone:
		if err != errInvalidChain {
			t.Fatalf("prior actual synchronization = %v, want invalid-chain error", err)
		}
	case <-time.After(3 * time.Second):
		d.cancel()
		<-oldDone
		t.Fatal("prior actual synchronization did not terminate")
	}
	select {
	case err := <-setupFailure:
		t.Fatal(err)
	default:
	}
	if len(d.processCh) != 1 {
		t.Fatal("actual failed synchronization did not leave its EOF")
	}
	if err := d.peers.Unregister(oldPeer.id); err != nil {
		t.Fatal(err)
	}
	t.Log("prior actual synchronization left EOF after its block-fetch invalid-chain error")

	releaseHashes := make(chan struct{})
	timer := time.AfterFunc(300*time.Millisecond, func() { close(releaseHashes) })
	defer timer.Stop()
	p := newPeer("next-peer", eth61, testHash('s', 7), nil, nil, nil)
	p.getAbsHashes = func(from uint64, count int) error {
		if from == 6 {
			<-releaseHashes
		}
		return d.DeliverHashes(p.id, peerReply(7, func(h uint64) types.Hash { return testHash('s', h) }, from, count))
	}
	p.getBlocks = func(requested []types.Hash) error {
		blocks := make([]*nom.DetailedMomentum, 0, len(requested))
		for _, hash := range requested {
			blocks = append(blocks, &nom.DetailedMomentum{Momentum: &nom.Momentum{Height: hashes[hash], Hash: hash}})
		}
		return d.DeliverBlocks(p.id, blocks)
	}
	if err := d.peers.Register(p); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- d.synchronise(p.id, p.head, 7) }()
	select {
	case err := <-done:
		d.wg.Wait()
		if err != nil {
			t.Fatalf("next synchronization failed: %v", err)
		}
		if height.Load() != 7 {
			t.Fatalf("next synchronization ended at %d, want 7", height.Load())
		}
	case <-time.After(2 * time.Second):
		pending, cached := d.queue.Size()
		active := atomic.LoadInt32(&d.synchronising)
		stack := make([]byte, 2*1024*1024)
		n := runtime.Stack(stack, true)
		if n == len(stack) {
			t.Fatal("controlled stack evidence exceeded its bound")
		}
		frames := string(stack[:n])
		if !strings.Contains(frames, "(*Downloader).fetchHashes(") || !strings.Contains(frames, "(*Downloader).syncWithPeer(") || strings.Contains(frames, "(*Downloader).fetchBlocks(") {
			t.Fatal("controlled worker graph differs from the qualified deadlock")
		}
		t.Log("CONTROL_WAIT_GRAPH=HASH_COMPLETION_HANDOFF_WITHOUT_BLOCK_FETCHER")
		d.cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("canceled control did not terminate")
		}
		d.wg.Wait()
		t.Fatalf("next synchronization stalled: height=%d pending=%d cached=%d active=%d", height.Load(), pending, cached, active)
	}
}
