"""Observe signals to an owned browser utility in a private tracefs instance.

No raw trace, process ID, executable, command line or path is emitted. This is
positive signal-generation evidence, not proof that an IPC disconnect started
with that signal. A browser can kill a utility after its IPC channel is lost.
"""
import json
import os
from pathlib import Path
import re
import select
import signal
import sys
import time
import uuid

TRACE = Path('/sys/kernel/tracing')
SIGNALS = {2: 'SIGINT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM', 31: 'SIGSYS'}


def bounded(path, cap=16384):
    with open(path, 'rb') as stream:
        raw = stream.read(cap+1)
    if len(raw) > cap:
        raise ValueError('BOUND')
    return raw.decode('utf-8', errors='strict')


def proc(pid):
    if type(pid) is not int or not 1 < pid < 2**31:
        raise ValueError('IDENTITY')
    values = {}
    for line in bounded(Path('/proc')/str(pid)/'status').splitlines():
        if line.startswith(('Tgid:', 'PPid:')):
            key, value = line.split(':', 1)
            values[key] = int(value.strip())
    stat = bounded(Path('/proc')/str(pid)/'stat', 4096).rsplit(')', 1)[1].split()
    return values['Tgid'], values['PPid'], int(stat[19])


def descendant(pid, parent):
    seen = set()
    for _ in range(12):
        if pid == parent:
            return True
        if pid <= 1 or pid in seen:
            return False
        seen.add(pid)
        pid = proc(pid)[1]
    return False


def classify_line(line, targets, browser, target, lookup=proc):
    # The event-specific pid is the recipient, common_pid in the prefix is the
    # generating thread. Never return either identifier or the comm field.
    match = re.fullmatch(r'\s*.+-(\d+)\s+\[\d+\].*?\s\d+\.\d+: signal_generate: sig=(\d+) errno=(-?\d+) code=(-?\d+) comm=.{1,64} pid=(\d+) grp=(\d+) res=(\d+)\s*', line)
    if not match:
        raise ValueError('FORMAT')
    sender, sig, _, code, recipient, _, result = map(int, match.groups())
    if recipient not in targets or not 1 <= sig <= 64 or not 0 <= result <= 4:
        raise ValueError('FILTER')
    role = 'UNRESOLVED'
    if code == 128:
        role = 'KERNEL_CONTEXT'
    else:
        try:
            group = lookup(sender)[0]
            role = 'OWNED_BROWSER' if group == browser else 'OWNED_NETWORK_SERVICE' if group == target else 'OTHER_PROCESS'
        except (OSError, ValueError, KeyError, IndexError):
            pass
    return {'signal': SIGNALS.get(sig, 'OTHER'), 'senderRole': role,
            'codeClass': {0: 'SI_USER', -6: 'SI_TKILL', 128: 'SI_KERNEL'}.get(code, 'OTHER'),
            'generationResult': ['ACCEPTED', 'IGNORED', 'ALREADY_PENDING', 'OVERFLOW_FAIL', 'LOSE_INFO'][result]}


def observe(browser, target, calibration=False):
    report = {'status': 'UNAVAILABLE', 'scope': 'OWNED_INITIAL_NETWORK_SERVICE_INITIAL_THREADS',
              'events': [], 'truncated': False, 'parseErrors': 0, 'rawTracePublished': False,
              'injectedSignals': 0, 'targetOwnershipVerified': False,
              'stopReason': 'NOT_STARTED', 'maximumWindowSeconds': 15}
    instance, pipe = None, None
    try:
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise ValueError('PLATFORM_OR_PERMISSION')
        start = proc(target)[2]
        if target == browser or not descendant(target, browser):
            raise ValueError('OWNERSHIP')
        if os.readlink('/proc/'+str(target)+'/exe') != os.readlink('/proc/'+str(browser)+'/exe'):
            raise ValueError('EXECUTABLE')
        report['targetOwnershipVerified'] = True
        threads = {int(p.name) for p in (Path('/proc')/str(target)/'task').iterdir()}
        if not 1 <= len(threads) <= 64 or target not in threads:
            raise ValueError('THREAD_BOUND')
        report['observedInitialThreads'] = len(threads)
        if not any(' - tracefs ' in line and line.split()[4] == str(TRACE) for line in bounded('/proc/self/mountinfo', 256*1024).splitlines()):
            raise ValueError('TRACEFS_MOUNT')
        instance = TRACE/'instances'/('bridge-signal-'+uuid.uuid4().hex)
        instance.mkdir()
        write = lambda name, value: (instance/name).write_text(value+'\n')
        write('tracing_on', '0')
        write('buffer_size_kb', '16')
        event = 'events/signal/signal_generate/'
        fmt = bounded(instance/(event+'format'))
        if any(not re.search(r'field:[^;\n]+\b'+name+r';', fmt) for name in ['sig', 'code', 'pid', 'group', 'result']):
            raise ValueError('EVENT_SCHEMA')
        write(event+'filter', ' || '.join('pid == '+str(tid) for tid in sorted(threads)))
        write(event+'enable', '1')
        pipe = os.open(instance/'trace_pipe', os.O_RDONLY | os.O_NONBLOCK)
        write('tracing_on', '1')
        if not calibration:
            print(json.dumps({'kind': 'READY'}), flush=True)
        if calibration:
            os.kill(target, signal.SIGTERM)
            report['injectedSignals'] = 1
        started, pending, total, stopped = time.monotonic(), '', 0, False
        report['stopReason'] = 'WINDOW_EXPIRED'
        while time.monotonic()-started < 15:
            readers = [pipe] if calibration or stopped else [pipe, sys.stdin]
            ready, _, _ = select.select(readers, [], [], 0.05)
            if sys.stdin in ready:
                if sys.stdin.readline(16) != 'STOP\n':
                    raise ValueError('PROTOCOL')
                write('tracing_on', '0')
                stopped = True
                report['stopReason'] = 'REQUESTED_PRE_TEARDOWN'
            if pipe in ready:
                raw = os.read(pipe, 4096)
                total += len(raw)
                if total > 65536:
                    report['truncated'] = True
                    break
                pending += raw.decode('utf-8', errors='strict')
                while '\n' in pending:
                    line, pending = pending.split('\n', 1)
                    if not line or line.startswith('#'):
                        continue
                    if len(line) > 2048 or len(report['events']) == 64:
                        report['truncated'] = True
                        break
                    try:
                        report['events'].append(classify_line(line, threads, browser, target))
                    except ValueError:
                        report['parseErrors'] += 1
                if report['truncated']:
                    break
            if stopped and pipe not in ready:
                break
            if calibration and report['events']:
                report['stopReason'] = 'CALIBRATION_EVENT_CAPTURED'
                break
            try:
                if proc(target)[2] != start:
                    write('tracing_on', '0')
                    stopped = True
                    report['stopReason'] = 'TARGET_EXIT_OR_REPLACED'
            except OSError:
                write('tracing_on', '0')
                stopped = True
                report['stopReason'] = 'TARGET_EXIT_OR_REPLACED'
        write('tracing_on', '0')
        stats = list((instance/'per_cpu').glob('cpu*/stats'))
        if not 1 <= len(stats) <= 256:
            raise ValueError('CPU_BOUND')
        losses = 0
        for file in stats:
            for line in bounded(file).splitlines():
                if line.split(':', 1)[0].strip() in ['overrun', 'commit overrun', 'dropped events']:
                    losses += int(line.split(':', 1)[1].strip())
        report['kernelBufferLosses'] = losses
        report['truncated'] |= losses > 0 or bool(pending)
        report['status'] = 'COMPLETE' if not report['truncated'] and report['parseErrors'] == 0 else 'INCOMPLETE'
    except (OSError, ValueError, KeyError, IndexError):
        report['status'] = 'UNAVAILABLE'
        report['reason'] = 'OWNED_SIGNAL_OBSERVATION_REFUSED'
    finally:
        if pipe is not None:
            os.close(pipe)
        if instance is not None:
            try:
                (instance/'tracing_on').write_text('0\n')
                (instance/'events/signal/signal_generate/enable').write_text('0\n')
                instance.rmdir()
            except OSError:
                report['status'] = 'INCOMPLETE'
                report['reason'] = 'OWNED_TRACE_INSTANCE_CLOSE_REFUSED'
    return report


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        child = os.fork()
        if child == 0:
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            while True:
                signal.pause()
        result = observe(os.getpid(), child, calibration=True)
        result['cleanupSignals'] = 0
        end = time.monotonic()+0.5
        while os.waitpid(child, os.WNOHANG)[0] == 0:
            if time.monotonic() >= end:
                break
            time.sleep(0.005)
        else:
            child = None
        if child is not None:
            os.kill(child, signal.SIGTERM)
            result['cleanupSignals'] = 1
            os.waitpid(child, 0)
        result['calibrationPassed'] = result['status'] == 'COMPLETE' and result['injectedSignals'] == 1 and result['cleanupSignals'] == 0 and result['events'] == [{'signal': 'SIGTERM', 'senderRole': 'OWNED_BROWSER', 'codeClass': 'SI_USER', 'generationResult': 'ACCEPTED'}]
        print(json.dumps({'schema': 1, 'status': 'PASS' if result['calibrationPassed'] else 'FAILURE', 'control': result}), flush=True)
        sys.exit(0 if result['calibrationPassed'] else 1)
    if len(sys.argv) != 4 or sys.argv[1] != '--watch':
        sys.exit(2)
    result = observe(int(sys.argv[2]), int(sys.argv[3]))
    print(json.dumps({'kind': 'RESULT', 'report': result}), flush=True)
    sys.exit(0 if result['status'] == 'COMPLETE' else 1)
