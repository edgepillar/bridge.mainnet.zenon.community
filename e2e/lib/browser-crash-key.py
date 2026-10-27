"""Read only bounded Crashpad annotation structures from an owned CI dump.

No memory, stack, environment, command, path, report ID or client ID is decoded.
Unknown error strings are represented by a digest, never emitted verbatim.
The layout follows Chromium 3ff7ac5a's vendored minidump_extensions.h.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys

MAX_FILE = 64 * 1024 * 1024
MAX_READ = 2 * 1024 * 1024
INTERFACES = {
    'network.mojom.WebSocket', 'network.mojom.WebSocketClient',
    'network.mojom.WebSocketHandshakeClient', 'network.mojom.URLLoader',
    'network.mojom.URLLoaderClient', 'network.mojom.NetworkContext',
    'network.mojom.NetworkService',
}
METHODS = {'OnDataFrame', 'OnDropChannel', 'OnConnectionEstablished',
           'OnOpeningHandshakeStarted', 'OnFailure', 'OnReceiveResponse',
           'OnReceiveRedirect', 'OnComplete', 'OnTransferSizeUpdated'}
VALIDATION = {
    'VALIDATION_ERROR_' + name for name in [
        'MISALIGNED_OBJECT', 'ILLEGAL_MEMORY_RANGE', 'UNEXPECTED_STRUCT_HEADER',
        'UNEXPECTED_ARRAY_HEADER', 'ILLEGAL_HANDLE', 'UNEXPECTED_INVALID_HANDLE',
        'ILLEGAL_POINTER', 'UNEXPECTED_NULL_POINTER', 'ILLEGAL_INTERFACE_ID',
        'UNEXPECTED_INVALID_INTERFACE_ID', 'MESSAGE_HEADER_INVALID_FLAGS',
        'MESSAGE_HEADER_MISSING_REQUEST_ID', 'MESSAGE_HEADER_UNKNOWN_METHOD',
        'DIFFERENT_SIZED_ARRAYS_IN_MAP', 'UNKNOWN_UNION_TAG', 'UNKNOWN_ENUM_VALUE',
        'DESERIALIZATION_FAILED', 'MAX_RECURSION_DEPTH',
    ]
}


def classify_message(raw):
    text = raw.decode('utf-8', errors='strict').rstrip('\0')
    result = {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
              'category': 'UNCLASSIFIED', 'validation': [], 'interfaces': [],
              'methods': []}
    if text in ['Frame too large', 'Received bad user message: Frame too large']:
        result['category'] = 'WEBSOCKET_FRAME_TOO_LARGE'
    result['validation'] = sorted(x for x in VALIDATION if re.search(r'(?<![A-Z_])'+x+r'(?![A-Z_])', text))
    result['interfaces'] = sorted(x for x in INTERFACES if re.search(r'(?<![A-Za-z0-9_.])'+re.escape(x)+r'(?![A-Za-z0-9_])', text))
    result['methods'] = sorted(x for x in METHODS if re.search(r'(?<![A-Za-z0-9_])'+x+r'(?![A-Za-z0-9_])', text))
    if result['validation']:
        result['category'] = 'MOJO_VALIDATION_ERROR'
    return result


class AnnotationReader:
    def __init__(self, read_at, size):
        if not 32 <= size <= MAX_FILE:
            raise ValueError('FILE_BOUND')
        self.read_at, self.size, self.read_bytes = read_at, size, 0

    def read(self, offset, size):
        if offset < 0 or size < 0 or offset + size > self.size or self.read_bytes + size > MAX_READ:
            raise ValueError('READ_BOUND')
        self.read_bytes += size
        raw = self.read_at(offset, size)
        if len(raw) != size:
            raise ValueError('INCOMPLETE')
        return raw

    def u32(self, offset):
        return struct.unpack('<I', self.read(offset, 4))[0]

    def location(self, offset):
        size, position = struct.unpack('<II', self.read(offset, 8))
        if size == position == 0:
            return None
        if size == 0 or position == 0 or position + size > self.size:
            raise ValueError('LOCATION_BOUND')
        return position, size

    def string(self, offset, maximum, terminated=True):
        size = self.u32(offset)
        if size > maximum:
            raise ValueError('STRING_BOUND')
        raw = self.read(offset + 4, size + int(terminated))
        if terminated and raw[-1:] != b'\0':
            raise ValueError('STRING_TERMINATOR')
        return raw[:size]

    def count(self, position, size, width, maximum):
        number = self.u32(position)
        if number > maximum or 4 + number * width > size:
            raise ValueError('COUNT_BOUND')
        return number

    def selected(self, name, value, typed=False):
        if name not in [b'mojo-message-error', b'ptype']:
            return
        raw = self.string(value, 4096, not typed)
        if name == b'mojo-message-error':
            self.messages.append(classify_message(raw))
        elif raw in [b'browser', b'renderer', b'utility', b'gpu-process']:
            self.process_types.add(raw.decode('ascii'))

    def dictionary(self, location, typed=False):
        if location is None:
            return
        position, size = location
        width = 12 if typed else 8
        for i in range(self.count(position, size, width, 4096)):
            item = position + 4 + i * width
            if typed:
                name, kind, reserved, value = struct.unpack('<IHHI', self.read(item, width))
                if reserved:
                    raise ValueError('ANNOTATION_RESERVED')
                # Crashpad Annotation::Type::kString is 1. Other values stay unread.
                if kind != 1:
                    continue
            else:
                name, value = struct.unpack('<II', self.read(item, width))
            self.selected(self.string(name, 128), value, typed)

    def parse(self):
        signature, version, streams, directory = struct.unpack('<4sIII', self.read(0, 16))
        if signature != b'MDMP' or version & 0xffff != 0xa793 or streams > 128:
            raise ValueError('HEADER')
        self.messages, self.process_types = [], set()
        info, exception = None, None
        for i in range(streams):
            kind, size, position = struct.unpack('<III', self.read(directory + i * 12, 12))
            if position + size > self.size:
                raise ValueError('STREAM_BOUND')
            if kind == 0x43500001:
                if info is not None:
                    raise ValueError('DUPLICATE_CRASHPAD_STREAM')
                info = position, size
            elif kind == 6:
                if size < 12:
                    raise ValueError('EXCEPTION_BOUND')
                exception = self.u32(position + 8)
        if info is not None:
            position, size = info
            if size < 52 or self.u32(position) < 1:
                raise ValueError('CRASHPAD_VERSION')
            # Skip the two UUIDs at offsets 4..35 entirely.
            self.dictionary(self.location(position + 36))
            modules = self.location(position + 44)
            if modules is not None:
                position, size = modules
                seen = set()
                for i in range(self.count(position, size, 12, 512)):
                    item = position + 4 + i * 12
                    index = self.u32(item)
                    if index in seen:
                        raise ValueError('DUPLICATE_MODULE')
                    seen.add(index)
                    module = self.location(item + 4)
                    if module is None:
                        raise ValueError('MISSING_MODULE')
                    p, n = module
                    if n < 20 or self.u32(p) < 1:
                        raise ValueError('MODULE_VERSION')
                    # Skip vector annotations and all standard module information.
                    self.dictionary(self.location(p + 12))
                    if n >= 28:
                        self.dictionary(self.location(p + 20), True)
        if len(self.messages) > 8:
            raise ValueError('MESSAGE_COUNT')
        return {'status':'COMPLETE', 'crashpadStreamPresent':info is not None,
                'messages':self.messages, 'processTypes':sorted(self.process_types),
                'exceptionCode':exception, 'bytesRead':self.read_bytes,
                'rawDumpPublished':False, 'otherAnnotationValuesRead':False}


def inspect_directory(directory):
    base = Path(directory)
    st = base.lstat()
    if not stat.S_ISDIR(st.st_mode) or base.is_symlink():
        raise ValueError('DIRECTORY')
    reports, count, total = [], 0, 0
    for name in ['pending', 'completed', 'new']:
        folder = base / name
        try:
            entry = folder.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(entry.st_mode) or folder.is_symlink() or entry.st_dev != st.st_dev:
            raise ValueError('CHILD_DIRECTORY')
        with os.scandir(folder) as entries:
            for item in entries:
                count += 1
                if count > 128:
                    raise ValueError('DIRECTORY_COUNT')
                if not re.fullmatch(r'[a-f0-9-]{36}\.dmp', item.name):
                    continue
                if len(reports) >= 8:
                    raise ValueError('DUMP_COUNT')
                fd = os.open(item.path, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    before = os.fstat(fd)
                    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_dev != st.st_dev:
                        raise ValueError('DUMP_IDENTITY')
                    total += before.st_size
                    if total > 256 * 1024 * 1024:
                        raise ValueError('TOTAL_BOUND')
                    value = AnnotationReader(lambda offset, size: os.pread(fd, size, offset), before.st_size).parse()
                    after = os.fstat(fd)
                    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise ValueError('DUMP_CHANGED')
                    reports.append(value)
                finally:
                    os.close(fd)
    return {'status':'COMPLETE', 'reports':reports,
            'rawDumpPublished':False, 'otherAnnotationValuesRead':False}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('ARGUMENTS')
        value = inspect_directory(sys.argv[1])
    except (ValueError, OSError, UnicodeError, struct.error):
        value = {'status':'UNAVAILABLE', 'reason':'OWNED_ANNOTATION_READ_REFUSED', 'rawDumpPublished':False}
        print(json.dumps(value))
        sys.exit(1)
    print(json.dumps(value))
