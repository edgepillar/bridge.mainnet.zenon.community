"""Parser/ownership controls; these never claim actual kernel tracing."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('signal_watch', Path(__file__).with_name('browser-signal-watch.py'))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class SignalTraceControls(unittest.TestCase):
    line = '  synthetic-203 [001] d... 1234.123456: signal_generate: sig=9 errno=0 code=0 comm=synthetic pid=304 grp=1 res=0'

    def test_browser_thread_is_classified_by_group(self):
        value = watch.classify_line(self.line, {304}, 200, 304, lambda _: (200, 1, 1))
        self.assertEqual(value, {'signal': 'SIGKILL', 'senderRole': 'OWNED_BROWSER', 'codeClass': 'SI_USER', 'generationResult': 'ACCEPTED'})

    def test_kernel_code_is_distinct_from_a_user_sender(self):
        value = watch.classify_line(self.line.replace('code=0', 'code=128'), {304}, 200, 304)
        self.assertEqual(value['senderRole'], 'KERNEL_CONTEXT')

    def test_gone_sender_remains_unresolved(self):
        def gone(_):
            raise ProcessLookupError()
        value = watch.classify_line(self.line, {304}, 200, 304, gone)
        self.assertEqual(value['senderRole'], 'UNRESOLVED')

    def test_recipient_outside_the_filter_is_refused(self):
        with self.assertRaises(ValueError):
            watch.classify_line(self.line, {305}, 200, 304)

    def test_malformed_records_and_generation_results_are_refused(self):
        for line in [self.line.replace('res=0', 'res=9'), self.line.replace('sig=9', 'sig=100'), 'raw unstructured data']:
            with self.assertRaises(ValueError):
                watch.classify_line(line, {304}, 200, 304)

    def test_raw_identifiers_and_names_are_excluded(self):
        value = watch.classify_line(self.line, {304}, 200, 304, lambda _: (304, 1, 1))
        self.assertEqual(value['senderRole'], 'OWNED_NETWORK_SERVICE')
        self.assertFalse(any(token in str(value) for token in ['203', '304', 'synthetic']))

    def test_an_owned_zygote_or_other_descendant_is_not_called_external(self):
        value = watch.classify_line(self.line, {304}, 200, 304, lambda _: (250, 200, 1), lambda child, parent: child == 250 and parent == 200)
        self.assertEqual(value['senderRole'], 'OWNED_BROWSER_DESCENDANT')


if __name__ == '__main__':
    unittest.main()
