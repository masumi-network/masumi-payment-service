import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


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


if __name__ == '__main__':
    unittest.main()
