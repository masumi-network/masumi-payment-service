import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


FLOW = Path(__file__).parent
ENTRYPOINTS = [
    ('run-hydra-e2e.sh', 'cmd_up', '5433'),
    ('run-hydra-e2e.sh', 'cmd_up_preprod', '5433'),
    ('replicate-benchmark.sh', 'cmd_db', '5434'),
]
DATABASE_BOUNDARY_REACHED = 77

BOUNDARY = '''
import json, os, signal, sys
from pathlib import Path
tool, args = Path(sys.argv[0]).name, sys.argv[1:]
with open(os.environ['CALLS'], 'a') as output:
    output.write(json.dumps([tool] + args) + '\\n')
def stop_at_database():
    os.kill(os.getppid(), signal.SIGUSR1)
if tool == 'curl':
    sys.exit(0)
if tool == 'npx':
    if os.environ.get('STOP_WITH_FAILURE') == '1':
        sys.exit(1)
    stop_at_database()
    sys.exit(0)
action = args[0]
if action == 'ps':
    if os.environ['DB_EXISTS'] == '1' and ('-a' in args or os.environ['DB_RUNNING'] == '1'):
        print(os.environ['DB_CONTAINER'])
elif action == 'inspect':
    print('bridge\\n' + os.environ['DB_BINDING'] + ' ' + os.environ['DB_PORT'])
elif action == 'port':
    print(os.environ['DB_BINDING'] + ':' + os.environ['DB_PORT'])
elif action == 'exec':
    if 'psql' in args:
        stop_at_database()
    elif 'pg_isready' not in args:
        sys.exit(90)
elif action not in ('info', 'run', 'start'):
    sys.exit(90)
'''


class DatabaseHarnessTest(unittest.TestCase):
    def function(self, source, name):
        inline = re.search(r'^' + name + r'\(\)\{[^\n]*\}$', source, re.MULTILINE)
        match = inline or re.search(r'^' + name + r'\(\)\{[^\n]*\n.*?^\}',
                                    source, re.MULTILINE | re.DOTALL)
        self.assertIsNotNone(match, name)
        return match.group()

    def run_harness(self, script, command, port, existing=False, binding='127.0.0.1', running=False,
                    full_script=False):
        source = (FLOW / script).read_text()
        names = [command]
        if command in ('cmd_all', 'cmd_demo'):
            names += ['cmd_up', 'cmd_evidence_reset']
        definitions = '\n'.join(self.function(source, name) for name in names)
        with tempfile.TemporaryDirectory(prefix='hydra db harness ') as directory:
            root = Path(directory)
            calls_file = root / 'calls'
            evidence = root / 'evidence'
            evidence.write_text('keep existing evidence')
            for tool in ('docker', 'curl', 'npx'):
                executable = root / tool
                executable.write_text('#!' + sys.executable + '\n' + BOUNDARY)
                executable.chmod(0o755)
            # Isolate the demo's fixed log path without changing control flow.
            definitions = definitions.replace('/tmp/hydra-e2e.log', str(root / 'demo.log'))
            shell = (
                'set -uo pipefail\n'
                'source "$HELPER"\n'
                'trap "exit ' + str(DATABASE_BOUNDARY_REACHED) + '" USR1\n'
                'c_blu(){ :; }; c_grn(){ :; }; c_red(){ :; }; banner(){ :; }\n'
                'blue(){ :; }; green(){ :; }; red(){ :; }\n'
                + definitions + '\n' + command + '\n'
            )
            env = {
                **os.environ,
                'PATH': str(root) + os.pathsep + '/usr/bin:/bin',
                'CALLS': str(calls_file),
                'HELPER': str((FLOW / 'test-db.sh').resolve()),
                'DB_CONTAINER': 'fixture-db',
                'DB_EXISTS': str(int(existing)),
                'DB_RUNNING': str(int(running)),
                'DB_BINDING': binding,
                'DB_PORT': port,
                'TEST_DB_PORT': port,
                'DATABASE_URL': 'postgresql://fixture@localhost:' + port + '/fixture',
                'NETWORK': 'devnet',
                'HYDRA_NATIVE': '1',
                'NODE1': 'http://127.0.0.1:4001',
                'EVIDENCE_TSV': str(evidence),
                'SETTLEMENT_STATE': str(root / 'settlement'),
            }
            invocation, cwd = ['bash', '-c', shell], None
            if full_script:
                cwd = root / 'hydra-l2-flow'
                cwd.mkdir()
                (cwd / script).write_text(source)
                (cwd / 'test-db.sh').write_text((FLOW / 'test-db.sh').read_text())
                env['STOP_WITH_FAILURE'] = '1'
                invocation = ['bash', './' + script, 'db']
            result = subprocess.run(invocation, env=env, cwd=cwd,
                                    capture_output=True, text=True, timeout=5)
            calls = [json.loads(line) for line in calls_file.read_text().splitlines()]
            return result, calls, evidence.exists()

    def assert_refused_before_database_work(self, result, calls):
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('Refusing test database container fixture-db', result.stderr)
        self.assertTrue(any(call[:2] == ['docker', 'inspect'] for call in calls))
        self.assertFalse(any(call[0] == 'npx' or
                             (call[0] == 'docker' and call[1] in ('run', 'start', 'exec'))
                             for call in calls), calls)

    def test_new_databases_publish_only_expected_loopback_port(self):
        for script, command, port in ENTRYPOINTS:
            with self.subTest(command=command):
                result, calls, _ = self.run_harness(script, command, port)
                self.assertEqual(result.returncode, DATABASE_BOUNDARY_REACHED, result.stderr)
                runs = [call for call in calls if call[:2] == ['docker', 'run']]
                self.assertEqual(len(runs), 1, calls)
                self.assertEqual(runs[0][runs[0].index('-p') + 1], '127.0.0.1:' + port + ':5432')

    def test_public_existing_databases_are_refused_by_each_entrypoint(self):
        for script, command, port in ENTRYPOINTS:
            with self.subTest(command=command):
                result, calls, _ = self.run_harness(script, command, port, existing=True, binding='0.0.0.0')
                self.assert_refused_before_database_work(result, calls)

    def test_loopback_existing_databases_are_inspected_before_start(self):
        for script, command, port in ENTRYPOINTS:
            with self.subTest(command=command):
                result, calls, _ = self.run_harness(script, command, port, existing=True)
                self.assertEqual(result.returncode, DATABASE_BOUNDARY_REACHED, result.stderr)
                self.assertTrue(any(call[:2] == ['docker', 'inspect'] for call in calls), calls)
                inspect = next(index for index, call in enumerate(calls) if call[:2] == ['docker', 'inspect'])
                start = next(index for index, call in enumerate(calls) if call[:2] == ['docker', 'start'])
                self.assertLess(inspect, start)
                self.assertFalse(any(call[:2] == ['docker', 'run'] for call in calls), calls)

    def test_precheck_refuses_public_databases_even_when_already_running(self):
        for running in (False, True):
            with self.subTest(running=running):
                result, calls, _ = self.run_harness('run-hydra-e2e.sh', 'cmd_precheck', '5433',
                                                    existing=True, binding='0.0.0.0', running=running)
                self.assert_refused_before_database_work(result, calls)

    def test_all_and_demo_stop_after_database_refusal(self):
        for command in ('cmd_all', 'cmd_demo'):
            with self.subTest(command=command):
                result, calls, has_evidence = self.run_harness('run-hydra-e2e.sh', command, '5433',
                                                              existing=True, binding='0.0.0.0')
                self.assert_refused_before_database_work(result, calls)
                self.assertTrue(has_evidence, 'the wrapper continued and reset evidence after refusing the database')
                self.assertNotIn('command not found', result.stderr)

    def test_benchmark_loads_helper_when_invoked_from_its_directory(self):
        result, calls, _ = self.run_harness('replicate-benchmark.sh', 'cmd_db', '5434', full_script=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(any(call[0] == 'npx' for call in calls), result.stderr)
        run = next(call for call in calls if call[:2] == ['docker', 'run'])
        self.assertEqual(run[run.index('-p') + 1], '127.0.0.1:5434:5432')
        self.assertNotIn('No such file or directory', result.stderr)


if __name__ == '__main__':
    unittest.main()
