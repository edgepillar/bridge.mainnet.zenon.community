"""Synthetic format, bounds and privacy controls; no actual crash is claimed."""
import importlib.util
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location('crash_key', Path(__file__).with_name('browser-crash-key.py'))
crash = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crash)


def fixture(typed=False):
    raw = bytearray(1024)
    struct.pack_into('<4sIII', raw, 0, b'MDMP', 0xa793, 1, 32)
    struct.pack_into('<III', raw, 32, 0x43500001, 64, 64)
    struct.pack_into('<I', raw, 64, 1)
    raw[68:100] = b'x' * 32
    def string(offset, value):
        struct.pack_into('<I', raw, offset, len(value))
        raw[offset+4:offset+5+len(value)] = value+b'\0'
    string(256, b'mojo-message-error')
    string(300, b'Frame too large')
    string(350, b'unrelated-secret-key')
    string(400, b'private@example.invalid /private/path')
    if typed:
        struct.pack_into('<II', raw, 108, 16, 144)
        struct.pack_into('<I', raw, 144, 1)
        struct.pack_into('<III', raw, 148, 0, 28, 176)
        struct.pack_into('<I', raw, 176, 1)
        struct.pack_into('<II', raw, 196, 28, 216)
        struct.pack_into('<I', raw, 216, 2)
        struct.pack_into('<IHHI', raw, 220, 256, 1, 0, 300)
        struct.pack_into('<IHHI', raw, 232, 350, 1, 0, 400)
    else:
        struct.pack_into('<II', raw, 100, 20, 144)
        struct.pack_into('<I', raw, 144, 2)
        struct.pack_into('<IIII', raw, 148, 256, 300, 350, 400)
    return bytes(raw)


class CrashKeyControls(unittest.TestCase):
    def parse(self, raw):
        def read(offset, size):
            # A parser that scans the file, UUIDs or unrelated values fails.
            for start, end in [(68, 100), (400, 450), (500, 1024)]:
                self.assertFalse(offset < end and start < offset + size)
            return raw[offset:offset+size]
        return crash.AnnotationReader(read, len(raw)).parse()

    def test_simple_annotation_only(self):
        value = self.parse(fixture())
        self.assertEqual(value['messages'][0]['category'], 'WEBSOCKET_FRAME_TOO_LARGE')
        self.assertFalse(value['otherAnnotationValuesRead'])
        self.assertNotIn('private', str(value))

    def test_typed_annotation_only(self):
        self.assertEqual(self.parse(fixture(True))['messages'][0]['category'], 'WEBSOCKET_FRAME_TOO_LARGE')

    def test_unknown_message_never_escapes(self):
        value = crash.classify_message(b'private@example.invalid /private/path token=secret')
        self.assertEqual(value['category'], 'UNCLASSIFIED')
        self.assertEqual(set(value), {'sha256','bytes','category','validation','interfaces','methods'})
        self.assertFalse(any(x in str(value) for x in ['example.invalid','/private/','token=']))

    def test_validation_identifiers_are_allowlisted(self):
        value = crash.classify_message(b'Validation failed for network.mojom.WebSocketClient.OnDataFrame [VALIDATION_ERROR_UNKNOWN_ENUM_VALUE] /private/ignored')
        self.assertEqual(value['category'], 'MOJO_VALIDATION_ERROR')
        self.assertEqual(value['interfaces'], ['network.mojom.WebSocketClient'])
        self.assertEqual(value['methods'], ['OnDataFrame'])
        self.assertEqual(value['validation'], ['VALIDATION_ERROR_UNKNOWN_ENUM_VALUE'])
        self.assertNotIn('/private', str(value))

    def test_missing_extension_is_explicit(self):
        raw = bytearray(fixture());struct.pack_into('<I', raw, 8, 0)
        self.assertFalse(self.parse(bytes(raw))['crashpadStreamPresent'])

    def test_malformed_locations_lengths_counts_and_signature_are_refused(self):
        for offset, value in [(0, 0), (8, 129), (104, 2048), (144, 4097), (256, 129), (300, 4097)]:
            raw = bytearray(fixture());struct.pack_into('<I', raw, offset, value)
            with self.assertRaises(ValueError):
                self.parse(bytes(raw))

    def test_unknown_annotation_type_does_not_read_its_value(self):
        raw = bytearray(fixture(True));struct.pack_into('<H', raw, 224, 2)
        self.assertEqual(self.parse(bytes(raw))['messages'], [])


if __name__ == '__main__':
    unittest.main()
