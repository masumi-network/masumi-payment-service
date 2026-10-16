import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

# 97-restart-node.sh runs hydra-native.sh verify before it stops a node, so
# the fake tree needs both scripts and a .sha256 record for the fake binary.
VERIFY_SCRIPTS = ('97-restart-node.sh', 'hydra-native.sh', 'hydra-native-bin.sh')
PIN = 'c' * 64


class RestartNodeTest(unittest.TestCase):
    def run_restart(self, root, scripts=None, record=True):
        flow = root / 'hydra-l2-flow'
        (flow / '.bin').mkdir(parents=True)
        (flow / '.native-state').mkdir(exist_ok=True)
        for name in VERIFY_SCRIPTS:
            shutil.copyfile(Path(__file__).with_name(name), flow / name)
            (flow / name).chmod(0o755)
        capture = root / 'args'
        binary = flow / '.bin' / 'hydra-node'
        commands = {
            binary:
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
        if record:
            digest = hashlib.sha256(binary.read_bytes()).hexdigest()
            (flow / '.bin' / 'hydra-node.sha256').write_text(f'{PIN}\n{digest}\n')
        env = {**os.environ, 'CAPTURE': str(capture), 'HYDRA_BINARY_SHA256': PIN,
               'HYDRA_BIN_TAG': '',
               'PATH': str(root) + os.pathsep + os.environ['PATH']}
        env.pop('HYDRA_SCRIPTS_TX_IDS', None)
        if scripts is not None:
            env['HYDRA_SCRIPTS_TX_IDS'] = scripts
        return subprocess.run(['bash', str(flow / '97-restart-node.sh'), '1'],
                              env=env, capture_output=True, timeout=10), capture

    def launch_args(self, scripts):
        with tempfile.TemporaryDirectory() as directory:
            result, capture = self.run_restart(Path(directory), scripts)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
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

    def test_unverified_binary_leaves_running_node_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            live = subprocess.Popen(['sleep', '30'])
            try:
                pid_file = root / 'hydra-l2-flow' / '.native-state' / 'node1.pid'
                pid_file.parent.mkdir(parents=True)
                pid_file.write_text(f'{live.pid}\n')
                result, capture = self.run_restart(root, record=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'refusing to run', result.stdout + result.stderr)
                self.assertIsNone(live.poll(), 'the running node was stopped')
                self.assertFalse(capture.exists(), 'the unverified binary ran')
            finally:
                live.kill()
                live.wait()


if __name__ == '__main__':
    unittest.main()
