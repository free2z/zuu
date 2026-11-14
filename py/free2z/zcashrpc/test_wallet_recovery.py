"""Exercise the production audit entry point and durable recovery scheduler."""
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from zcashrpc.wallet_hydration import main
from zcashrpc.wallet_recovery import recover


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.wallet = str(Path(self.tmp.name) / 'wallet')
        self.state = str(Path(self.tmp.name) / 'recovery')
        self.config = dict(binary='wallet-recover', server='https://provider.invalid', network='main', state_path=self.state)
        with sqlite3.connect(self.wallet) as db:
            db.executescript('CREATE TABLE transactions(id_tx INTEGER PRIMARY KEY,txid BLOB,raw BLOB,mined_height INTEGER);'
                             'CREATE TABLE orchard_received_notes(transaction_id INTEGER,value INTEGER,memo BLOB);'
                             'CREATE INDEX notes_tx ON orchard_received_notes(transaction_id);')
            db.execute('INSERT INTO transactions VALUES(1,?,NULL,100)', (bytes(32),))
            db.execute('INSERT INTO orchard_received_notes VALUES(1,100000,NULL)')
            # No queue at all: the original enhancement request was consumed.

    def test_notfound_then_restart_hydration_and_duplicate(self):
        calls = []

        def provider(args, *unused):
            calls.append(args)
            if len(calls) == 2:
                with sqlite3.connect(self.wallet) as db:
                    db.execute("UPDATE transactions SET raw=x'01'")
                    db.execute("UPDATE orchard_received_notes SET memo=x'f6'")
                return b'hydrated\n'
            return b'unavailable\n'

        with patch('zcashrpc.wallet_recovery.run_recovery_command', side_effect=provider):
            self.assertEqual(recover(self.wallet, **self.config, now=0), 1)
            self.assertEqual(recover(self.wallet, **self.config, now=1), 0)
            self.assertEqual(recover(self.wallet, **self.config, now=300), 1)
            self.assertEqual(recover(self.wallet, **self.config, now=600), 0)
        self.assertEqual(len(calls), 2)
        self.assertIn('--height', calls[0])

    def test_budget_survives_failure_and_restart(self):
        with patch('zcashrpc.wallet_recovery.run_recovery_command', side_effect=subprocess.TimeoutExpired('wallet-recover', 20)) as command:
            for now in (0, 300, 600):
                with self.assertRaises(subprocess.TimeoutExpired):
                    recover(self.wallet, **self.config, now=now)
            self.assertEqual(recover(self.wallet, **self.config, now=900), 0)
            self.assertEqual(command.call_count, 3)

    def test_command_failure_prevents_successful_audit(self):
        env = dict(WALLET_DB=self.wallet, WALLET_RECOVERY_BINARY='wallet-recover',
                   WALLET_RECOVERY_SERVER=self.config['server'], WALLET_RECOVERY_NETWORK='main',
                   WALLET_RECOVERY_STATE=self.state)
        with patch.dict(os.environ, env), patch('zcashrpc.wallet_recovery.run_recovery_command', side_effect=subprocess.CalledProcessError(1, 'wallet-recover')):
            self.assertEqual(main(), 1)

    def test_wallet_cannot_be_retry_state(self):
        self.config['state_path'] = self.wallet
        with self.assertRaises(ValueError):
            recover(self.wallet, **self.config)

    def test_genuine_no_memo_never_requests_recovery(self):
        with sqlite3.connect(self.wallet) as db:
            db.execute("UPDATE transactions SET raw=x'01'")
            db.execute("UPDATE orchard_received_notes SET memo=x'f6'")
        with patch('zcashrpc.wallet_recovery.run_recovery_command') as command:
            self.assertEqual(recover(self.wallet, **self.config, now=0), 0)
            command.assert_not_called()

    def test_batch_bound_and_fairness_survive_reopen(self):
        with sqlite3.connect(self.wallet) as db:
            for i in range(2, 8):
                db.execute('INSERT INTO transactions VALUES(?,?,NULL,100)', (i, bytes([i])*32))
                db.execute('INSERT INTO orchard_received_notes VALUES(?,1,NULL)', (i,))
        with patch('zcashrpc.wallet_recovery.run_recovery_command', return_value=b'unavailable\n') as command:
            self.assertEqual(recover(self.wallet, **self.config, now=0), 5)
            self.assertEqual(recover(self.wallet, **self.config, now=0), 2)
            self.assertEqual(recover(self.wallet, **self.config, now=1), 0)
            self.assertEqual(command.call_count, 7)

    def test_hardlink_alias_and_wallet_companions_are_never_written(self):
        original = Path(self.wallet).read_bytes()
        alias = Path(self.tmp.name) / 'hardlink'
        os.link(self.wallet, alias)
        for path in (str(alias), self.wallet + '-wal', self.wallet + '-shm'):
            self.config['state_path'] = path
            with self.assertRaises(ValueError):
                recover(self.wallet, **self.config)
            self.assertEqual(Path(self.wallet).read_bytes(), original)
        alias.unlink()
        companion = Path(self.wallet + '-wal')
        companion.write_bytes(b'wallet companion sentinel')
        os.link(companion, alias)
        self.config['state_path'] = str(alias)
        with self.assertRaises(ValueError):
            recover(self.wallet, **self.config)
        self.assertEqual(companion.read_bytes(), b'wallet companion sentinel')
        self.assertEqual(Path(self.wallet).read_bytes(), original)

    def test_existing_unowned_schema_and_symlinks_are_not_adopted(self):
        with sqlite3.connect(self.state) as state:
            state.execute('CREATE TABLE unrelated(value TEXT)')
        os.chmod(self.state, 0o600)
        before = Path(self.state).read_bytes()
        with self.assertRaises(ValueError):
            recover(self.wallet, **self.config)
        self.assertEqual(Path(self.state).read_bytes(), before)
        Path(self.state).unlink()
        Path(self.state).symlink_to(self.wallet)
        with self.assertRaises(OSError):
            recover(self.wallet, **self.config)

    def test_nonprivate_directory_or_file_rejected(self):
        os.chmod(self.tmp.name, 0o755)
        with self.assertRaises(ValueError):
            recover(self.wallet, **self.config)
        os.chmod(self.tmp.name, 0o700)
        with patch('zcashrpc.wallet_recovery.run_recovery_command', return_value=b'unavailable\n'):
            recover(self.wallet, **self.config)
        os.chmod(self.state, 0o644)
        before = Path(self.state).read_bytes()
        with self.assertRaises(ValueError):
            recover(self.wallet, **self.config)
        self.assertEqual(Path(self.state).read_bytes(), before)

    def test_replacement_during_open_is_detected_without_wallet_write(self):
        from zcashrpc import wallet_recovery as recovery
        before = Path(self.wallet).read_bytes()
        real_connect = sqlite3.connect

        def replace(location, **kwargs):
            if '?mode=rw' in location:
                Path(self.state).unlink()
                os.symlink(self.wallet, self.state)
            return real_connect(location, **kwargs)

        with patch.object(recovery.sqlite3, 'connect', side_effect=replace), self.assertRaises(ValueError):
            recover(self.wallet, **self.config)
        self.assertEqual(Path(self.wallet).read_bytes(), before)

    def test_large_retained_set_exhausted_first_durable_checkpoint(self):
        from zcashrpc.wallet_recovery import ScanBudgetExceeded
        with patch('zcashrpc.wallet_recovery.run_recovery_command', return_value=b'unavailable\n'):
            recover(self.wallet, **self.config, now=0)
        with sqlite3.connect(self.wallet) as wallet:
            wallet.executemany('INSERT INTO transactions VALUES(?,?,NULL,100)',
                               ((i, i.to_bytes(32, 'little')) for i in range(2, 1030)))
            wallet.executemany('INSERT INTO orchard_received_notes VALUES(?,1,NULL)',
                               ((i,) for i in range(2, 1030)))
        with sqlite3.connect(self.state) as state:
            state.execute('UPDATE recovery SET attempts=3,next_at=0')
            state.executemany('INSERT OR IGNORE INTO recovery VALUES(?,3,0)',
                              ((i.to_bytes(32, 'little'),) for i in range(1, 1025)))
            # Large stale history is never enumerated by recovery.
            state.executemany('INSERT OR IGNORE INTO recovery VALUES(?,0,0)',
                              ((i.to_bytes(32, 'little'),) for i in range(10000, 30000)))
        with patch('zcashrpc.wallet_recovery.run_recovery_command', return_value=b'unavailable\n') as command, \
                patch('zcashrpc.wallet_recovery.time.monotonic', return_value=0):
            for expected in (256, 512, 768, 1024):
                with self.assertRaises(ScanBudgetExceeded):
                    recover(self.wallet, **self.config, now=300)
                with sqlite3.connect(self.state) as state:
                    self.assertEqual(state.execute('SELECT cursor FROM checkpoint').fetchone()[0], expected)
            command.assert_not_called()
            self.assertEqual(recover(self.wallet, **self.config, now=300), 5)
            self.assertEqual(command.call_count, 5)
            self.assertEqual(bytes.fromhex(command.call_args.args[0][-3])[::-1], (1029).to_bytes(32, 'little'))

    def test_scan_opcode_and_schema_budgets_fail_closed(self):
        # A large schema is rejected during bounded enumeration, before state write.
        with sqlite3.connect(self.wallet) as wallet:
            for i in range(260):
                wallet.execute(f'CREATE TABLE extra_{i}(v)')
        with patch.dict(os.environ, {'WALLET_DB': self.wallet}):
            self.assertEqual(main(), 1)
        self.assertFalse(Path(self.state).exists())

    def test_real_command_output_cap_timeout_failure_and_protocol(self):
        import sys
        from zcashrpc.wallet_recovery import run_recovery_command
        with self.assertRaises(ValueError):
            run_recovery_command([sys.executable, '-c', 'import os; os.write(2,b"x"*1000000)'], 2)
        with self.assertRaises(subprocess.TimeoutExpired):
            run_recovery_command([sys.executable, '-c', 'import time; time.sleep(30)'], .05)
        with self.assertRaises(subprocess.CalledProcessError):
            run_recovery_command([sys.executable, '-c', 'raise SystemExit(7)'], 2)
        self.assertEqual(run_recovery_command([sys.executable, '-c', 'print("unavailable")'], 2), b'unavailable\n')

    def test_sql_work_cap_fails_closed(self):
        with sqlite3.connect(self.wallet) as wallet:
            wallet.executemany('INSERT INTO orchard_received_notes VALUES(1,1,NULL)', (() for _ in range(3000)))
        with patch('zcashrpc.wallet_hydration.SQL_STEPS', 0), patch.dict(os.environ, {'WALLET_DB': self.wallet}):
            self.assertEqual(main(), 1)

    def test_elapsed_scan_deadline_fails_audit_without_success(self):
        clock = iter([0, 0])

        def now():
            return next(clock, 30)

        env = dict(WALLET_DB=self.wallet, WALLET_RECOVERY_BINARY='wallet-recover',
                   WALLET_RECOVERY_SERVER=self.config['server'], WALLET_RECOVERY_NETWORK='main',
                   WALLET_RECOVERY_STATE=self.state)
        with patch.dict(os.environ, env), patch('zcashrpc.wallet_recovery.time.monotonic', side_effect=now):
            self.assertEqual(main(), 1)

    def test_small_row_cap_commits_checkpoint_before_refusal(self):
        from zcashrpc.wallet_recovery import ScanBudgetExceeded
        with sqlite3.connect(self.wallet) as wallet:
            wallet.execute('INSERT INTO transactions VALUES(2,?,NULL,100)', (bytes([2])*32,))
            wallet.execute('INSERT INTO orchard_received_notes VALUES(2,1,NULL)')
        with patch('zcashrpc.wallet_recovery.SCAN_ROWS', 1), patch('zcashrpc.wallet_recovery.run_recovery_command', return_value=b'unavailable\n') as command:
            with self.assertRaises(ScanBudgetExceeded):
                recover(self.wallet, **self.config, now=0)
            with sqlite3.connect(self.state) as state:
                self.assertEqual(state.execute('SELECT cursor FROM checkpoint').fetchone()[0], 1)
            self.assertEqual(recover(self.wallet, **self.config, now=0), 1)
            self.assertEqual(command.call_count, 2)
