import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import unittest


CAPTURE_TIMEOUT_SECONDS = 2
CAPTURE_POLL_SECONDS = 0.01


class RestartNodeTest(unittest.TestCase):
    def launch_args(self, scripts):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            flow = root / 'hydra-l2-flow'
            (flow / '.bin').mkdir(parents=True)
            (flow / '.native-state').mkdir()
            script = flow / '97-restart-node.sh'
            shutil.copyfile(Path(__file__).with_name(script.name), script)
            capture = root / 'args'
            commands = {
                flow / '.bin' / 'hydra-node':
                    '#!/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE"\n',
                root / 'curl':
                    '#!/bin/bash\n'
                    'for i in {1..100}; do\n'
                    '  [ -s "$CAPTURE" ] && exit 0\n'
                    '  sleep 0.01\n'
                    'done\nexit 1\n',
            }
            for path, contents in commands.items():
                path.write_text(contents)
                path.chmod(0o755)
            env = {**os.environ, 'CAPTURE': str(capture),
                   'PATH': str(root) + os.pathsep + os.environ['PATH']}
            env.pop('HYDRA_SCRIPTS_TX_IDS', None)
            if scripts is not None:
                env['HYDRA_SCRIPTS_TX_IDS'] = scripts
            subprocess.run(['bash', str(script), '1'], env=env,
                           check=True, capture_output=True, timeout=5)
            return capture.read_text().splitlines()

    def assert_network_default(self, scripts):
        args = self.launch_args(scripts)
        self.assertEqual(args.count('--network'), 1)
        self.assertEqual(args[args.index('--network') + 1], 'preprod')
        self.assertNotIn('--hydra-scripts-tx-id', args)

    def test_unset_uses_network_default(self):
        self.assert_network_default(None)

    def test_empty_uses_network_default(self):
        self.assert_network_default('')

    def test_custom_publication_replaces_network_default(self):
        scripts = 'a' * 64 + ',' + 'b' * 64
        args = self.launch_args(scripts)
        self.assertEqual(args.count('--hydra-scripts-tx-id'), 1)
        self.assertEqual(args[args.index('--hydra-scripts-tx-id') + 1], scripts)
        self.assertNotIn('--network', args)

    def test_restart_does_not_enable_public_monitoring(self):
        self.assertNotIn('--monitoring-port', self.launch_args(None))

    def native_launch_args(self, function_name, invocation):
        source = Path(__file__).with_name('hydra-native.sh').read_text()
        function = re.search(r'^' + function_name + r'\(\)\{\n.*?^\}',
                             source, re.MULTILINE | re.DOTALL)
        self.assertIsNotNone(function)
        with tempfile.TemporaryDirectory(prefix='hydra monitoring ') as directory:
            root = Path(directory)
            capture = root / 'args'
            binary = root / 'fake hydra-node'
            binary.write_text(
                '#!/bin/bash\n'
                'printf "%s\\0" "$@" > "$CAPTURE.tmp"\n'
                'mv "$CAPTURE.tmp" "$CAPTURE"\n')
            binary.chmod(0o755)
            env = {
                **os.environ,
                'CAPTURE': str(capture),
                'NATIVE_BIN': str(binary),
                'DEMO': directory,
                'STATE': directory,
                'PREPROD_DIR': directory,
                'PERSIST_SUBDIR': 'persistence',
                'NETWORK': 'preprod',
                'HOST_SOCKET': str(root / 'node.socket'),
                'SCRIPTS_TX_ID': 'a' * 64,
                'HYDRA_SCRIPTS_TX_IDS': 'a' * 64,
            }
            subprocess.run(['bash', '-uc', function.group() + '\n' + invocation + '\nwait\n'],
                           env=env, check=True, capture_output=True, timeout=5)
            # The devnet launcher detaches its child inside a subshell.
            deadline = time.monotonic() + CAPTURE_TIMEOUT_SECONDS
            while not capture.exists() and time.monotonic() < deadline:
                time.sleep(CAPTURE_POLL_SECONDS)
            self.assertTrue(capture.exists(), 'the native node did not receive its arguments')
            return capture.read_bytes().decode().split('\0')[:-1]

    def assert_native_monitoring_disabled(self, args):
        self.assertNotIn('--monitoring-port', args)
        self.assertEqual(args[args.index('--api-host') + 1], '127.0.0.1')
        self.assertEqual(args[args.index('--listen') + 1], '127.0.0.1:5001')

    def test_devnet_launch_does_not_enable_public_monitoring(self):
        args = self.native_launch_args(
            'start_node',
            'start_node 1 alice.sk bob.vk carol.vk alice.sk bob.vk carol.vk "$DEMO/persistence/alice"')
        self.assert_native_monitoring_disabled(args)

    def test_preprod_launch_does_not_enable_public_monitoring(self):
        args = self.native_launch_args('start_node_preprod', 'start_node_preprod 1 purchasing')
        self.assert_native_monitoring_disabled(args)


if __name__ == '__main__':
    unittest.main()
