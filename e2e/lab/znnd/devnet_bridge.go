// Added to go-zenon's vm/constants by the bridge lab (e2e/lab/lab.sh). Not
// part of go-zenon.
//
// The bridge cannot be set up on a stock devnet: its administrator is an
// address compiled into znnd that no devnet key holds, and its time
// challenges last a day or two of momentums. go-zenon's own tests get round
// this by assigning these variables at run time
// (vm/embedded/tests/z_bridge_test.go, activateBridgeStep0); this does the
// same from the environment, and only when asked.
//
// These values are consensus rules. Every node of the lab runs this image
// with the same environment, so they agree; a node without it would fork.

package constants

import (
	"os"

	"github.com/zenon-network/go-zenon/common/types"
)

func init() {
	if os.Getenv("ZNN_DEVNET_BRIDGE") != "1" {
		return
	}
	if a := os.Getenv("ZNN_BRIDGE_ADMIN"); a != "" {
		InitialBridgeAdministrator = types.ParseAddressPanic(a)
	}
	// Short enough that a test's setup is a few momentums, not two days.
	MinUnhaltDurationInMomentums = 1
	MinAdministratorDelay = 2
	MinSoftDelay = 1
	// Guardians only matter for the emergency path, which the lab does not use.
	MinGuardians = 0
}
