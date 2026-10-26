import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HELPER = Path(__file__).with_name('test-db.sh')


class TestDatabaseBindingTest(unittest.TestCase):
    def check_binding(self, inspection, port='5433', inspect_status=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / 'docker'
            docker.write_text(
                '#!/bin/bash\n'
                'printf "%s\\n" "$1" >> "$DOCKER_CALLS"\n'
                '[[ "$1" = inspect && "$2" = --format && "$4" = test-db ]] || exit 2\n'
                'printf "%s" "$DOCKER_INSPECTION"\n'
                'exit "$DOCKER_INSPECT_STATUS"\n'
            )
            docker.chmod(0o755)
            calls = root / 'calls'
            env = {
                **os.environ,
                'PATH': str(root) + os.pathsep + os.environ['PATH'],
                'DOCKER_INSPECTION': inspection,
                'DOCKER_INSPECT_STATUS': str(inspect_status),
                'DOCKER_CALLS': str(calls),
            }
            result = subprocess.run(
                ['bash', '-c',
                 'set -euo pipefail; source "$1"; '
                 'assert_test_db_loopback_binding "$2" "$3"',
                 'binding-test', str(HELPER), 'test-db', port],
                env=env, capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(calls.read_text(), 'inspect\n')
            return result

    def assert_refused(self, inspection, **kwargs):
        result = self.check_binding(inspection, **kwargs)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('Refusing test database container test-db', result.stderr)
        self.assertIn('Back up its data', result.stderr)
        self.assertIn('leaves this container unchanged', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_accepts_loopback_at_requested_port_on_bridge_networks(self):
        for mode, port in [('default', '5433'), ('bridge', '5433'), ('custom-network', '5434')]:
            with self.subTest(mode=mode, port=port):
                result = self.check_binding(f'{mode}\n127.0.0.1 {port}\n', port=port)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout + result.stderr, '')

    def test_refuses_public_missing_or_nonstandard_host_ips(self):
        for host_ip in ['', '0.0.0.0', '::', '::1', '192.168.1.10']:
            with self.subTest(host_ip=host_ip):
                self.assert_refused(f'default\n{host_ip} 5433\n')

    def test_refuses_missing_bindings_ports_and_wrong_ports(self):
        for inspection in ['default\n', 'default\n127.0.0.1\n', 'default\n127.0.0.1 5434\n']:
            with self.subTest(inspection=inspection):
                self.assert_refused(inspection)

    def test_checks_every_binding(self):
        for second_binding in ['0.0.0.0 5433', ':: 5433', '127.0.0.1 5434']:
            with self.subTest(second_binding=second_binding):
                self.assert_refused(f'default\n127.0.0.1 5433\n{second_binding}\n')

    def test_refuses_network_modes_that_ignore_port_publishing(self):
        for mode in ['host', 'container:other-db', '']:
            with self.subTest(mode=mode):
                self.assert_refused(f'{mode}\n127.0.0.1 5433\n')

    def test_refuses_inspect_failure_even_with_safe_output(self):
        self.assert_refused('default\n127.0.0.1 5433\n', inspect_status=1)


if __name__ == '__main__':
    unittest.main()
