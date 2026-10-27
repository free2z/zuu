import json
import sqlite3

from zcashrpc import wallet_tip


NOW = 1_756_000_000


def test_parse_latest_block_accepts_proto_uint64_string_and_integer():
    assert wallet_tip.parse_latest_block('{"height":"3480001"}') == 3480001
    assert wallet_tip.parse_latest_block('{"height":3480001}') == 3480001


def test_parse_latest_block_rejects_unit_or_provider_shape_errors():
    for payload in (
        '{"height":true}',
        '{"height":3.5}',
        '{"height":"-1"}',
        '{"height":"3480001.0"}',
        '{}',
    ):
        try:
            wallet_tip.parse_latest_block(payload)
        except ValueError:
            pass
        else:
            raise AssertionError(f"accepted invalid payload {payload}")


def test_wallet_height_reads_max_committed_height_read_only(tmp_path):
    db = tmp_path / "wallet.sqlite"
    connection = sqlite3.connect(db)
    connection.execute("create table blocks (height integer)")
    connection.executemany("insert into blocks values (?)", [(12,), (17,)])
    connection.commit()
    connection.close()

    assert wallet_tip.wallet_height(str(db)) == 17


def test_wallet_height_rejects_invalid_negative_height(tmp_path):
    db = tmp_path / "wallet.sqlite"
    connection = sqlite3.connect(db)
    connection.execute("create table blocks (height integer)")
    connection.execute("insert into blocks values (-1)")
    connection.commit()
    connection.close()

    try:
        wallet_tip.wallet_height(str(db))
    except ValueError as exc:
        assert "negative" in str(exc)
    else:
        raise AssertionError("accepted a negative wallet height")


def test_main_leaves_margin_between_wallet_read_and_provider_budget(monkeypatch, tmp_path):
    observed = {}
    monkeypatch.setenv("CREDIT_WALLET_TIP_STATE", str(tmp_path / "state.json"))
    monkeypatch.setenv("CREDIT_WALLET_TIP_WALLET_DB", str(tmp_path / "wallet"))
    monkeypatch.setenv("CREDIT_WALLET_TIP_TIMEOUT", "30")
    monkeypatch.setenv("CREDIT_WALLET_TIP_GRPC_TIMEOUT", "15")

    def read_wallet(_path, timeout):
        observed["wallet_timeout"] = timeout
        return 3480000

    monkeypatch.setattr(wallet_tip, "wallet_height", read_wallet)
    monkeypatch.setattr(wallet_tip, "upstream_height", lambda *_args: 3480000)
    assert wallet_tip.main([]) == 0
    assert observed["wallet_timeout"] == 5


def test_observer_budgets_normalize_small_outer_and_large_grpc_values():
    assert wallet_tip.observer_budgets(2, 1) == (30, 1, 5)
    assert wallet_tip.observer_budgets(1, 15) == (30, 15, 5)
    assert wallet_tip.observer_budgets(30, 29) == (30, 15, 5)
def test_upstream_height_uses_valid_empty_chain_spec_and_latest_block_method(
    monkeypatch,
):
    completed = type("Completed", (), {
        "returncode": 0,
        "stdout": '{"height":"3480001"}',
        "stderr": "",
    })()
    captured = {}

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return completed

    monkeypatch.setattr(wallet_tip.subprocess, "run", fake_run)
    assert wallet_tip.upstream_height("/usr/bin/grpcurl", "zec.rocks:443", 15) == 3480001
    assert captured["argv"] == [
        "/usr/bin/grpcurl", "-max-time", "15", "-d", "{}",
        "zec.rocks:443", wallet_tip.GET_LATEST_BLOCK,
    ]
    assert json.loads(captured["argv"][4]) == {}
    assert captured["kwargs"]["timeout"] == 15.0


def test_stale_upstream_is_reported_even_when_wallet_and_credit_activity_are_idle():
    previous = {
        "version": 1,
        "source": wallet_tip.DEFAULT_TARGET,
        "wallet": {"height": 3480000, "since": NOW - 1201},
        "upstream": {"height": 3480000, "since": NOW - 1201},
    }
    lines, state = wallet_tip.evaluate(
        3480000, 3480000, NOW, previous, stale_seconds=1200
    )

    assert any(line.startswith(wallet_tip.WALLET_TIP_STALE_SIGNAL) for line in lines)
    assert any(line.startswith(wallet_tip.WALLET_TIP_OK_SIGNAL) for line in lines)
    assert state["wallet"]["since"] == NOW - 1201


def test_moving_wallet_that_exceeds_behind_threshold_is_reported():
    previous = {
        "version": 1,
        "source": wallet_tip.DEFAULT_TARGET,
        "wallet": {"height": 3480000, "since": NOW - 10},
        "upstream": {"height": 3480000, "since": NOW - 10},
    }
    lines, _state = wallet_tip.evaluate(
        3480001, 3480050, NOW, previous, stale_seconds=1200, behind_blocks=40
    )

    assert any(line.startswith(wallet_tip.WALLET_TIP_BEHIND_SIGNAL) for line in lines)
    assert not any(line.startswith(wallet_tip.WALLET_TIP_STALE_SIGNAL) for line in lines)
    assert any(line.startswith(wallet_tip.WALLET_TIP_OK_SIGNAL) for line in lines)


def test_provider_failure_does_not_reset_persisted_baseline(monkeypatch, tmp_path,
                                                           capsys):
    state = {
        "version": 1,
        "source": wallet_tip.DEFAULT_TARGET,
        "wallet": {"height": 3480000, "since": NOW - 1201},
        "upstream": {"height": 3480000, "since": NOW - 1201},
    }
    state_path = tmp_path / "wallet-tip.json"
    assert wallet_tip.write_state(state, state_path) is None
    monkeypatch.setenv("CREDIT_WALLET_TIP_STATE", str(state_path))
    monkeypatch.setenv("CREDIT_WALLET_TIP_WALLET_DB", str(tmp_path / "wallet"))
    monkeypatch.setattr(wallet_tip, "wallet_height", lambda *_args: 3480000)
    monkeypatch.setattr(
        wallet_tip, "upstream_height",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("provider unavailable")),
    )

    assert wallet_tip.main([]) == 0
    output = capsys.readouterr().out
    assert wallet_tip.WALLET_TIP_PROVIDER_ERROR_SIGNAL in output
    assert json.loads(state_path.read_text()) == state


def test_corrupt_state_suppresses_success_and_is_not_overwritten(
    monkeypatch, tmp_path, capsys
):
    state_path = tmp_path / "wallet-tip.json"
    state_path.write_text("not json")
    monkeypatch.setenv("CREDIT_WALLET_TIP_STATE", str(state_path))
    monkeypatch.setenv("CREDIT_WALLET_TIP_WALLET_DB", str(tmp_path / "wallet"))
    monkeypatch.setattr(wallet_tip, "wallet_height", lambda *_args: 3480000)
    monkeypatch.setattr(wallet_tip, "upstream_height", lambda *_args: 3480000)

    assert wallet_tip.main([]) == 0
    output = capsys.readouterr().out
    assert wallet_tip.WALLET_TIP_STATE_ERROR_SIGNAL in output
    assert wallet_tip.WALLET_TIP_OK_SIGNAL not in output
    assert state_path.read_text() == "not json"


def test_unwritable_state_suppresses_success(monkeypatch, tmp_path, capsys):
    state_path = tmp_path / "wallet-tip.json"
    monkeypatch.setenv("CREDIT_WALLET_TIP_STATE", str(state_path))
    monkeypatch.setenv("CREDIT_WALLET_TIP_WALLET_DB", str(tmp_path / "wallet"))
    monkeypatch.setattr(wallet_tip, "wallet_height", lambda *_args: 3480000)
    monkeypatch.setattr(wallet_tip, "upstream_height", lambda *_args: 3480000)
    monkeypatch.setattr(
        wallet_tip,
        "write_state",
        lambda *_args: "could not write wallet-tip.json: permission denied",
    )

    assert wallet_tip.main([]) == 0
    output = capsys.readouterr().out
    assert wallet_tip.WALLET_TIP_STATE_ERROR_SIGNAL in output
    assert wallet_tip.WALLET_TIP_OK_SIGNAL not in output


def test_missing_state_starts_a_new_baseline_and_real_main_persists_success(
    monkeypatch, tmp_path, capsys
):
    db = tmp_path / "wallet.sqlite"
    connection = sqlite3.connect(db)
    connection.execute("create table blocks (height integer)")
    connection.execute("insert into blocks values (3480000)")
    connection.commit()
    connection.close()
    state_path = tmp_path / "wallet-tip.json"
    monkeypatch.setenv("CREDIT_WALLET_TIP_STATE", str(state_path))
    monkeypatch.setenv("CREDIT_WALLET_TIP_WALLET_DB", str(db))
    monkeypatch.setattr(wallet_tip, "upstream_height", lambda *_args: 3480001)
    monkeypatch.setattr(wallet_tip.time, "time", lambda: NOW)

    assert wallet_tip.main([]) == 0
    output = capsys.readouterr().out
    assert wallet_tip.WALLET_TIP_OK_SIGNAL in output
    assert wallet_tip.WALLET_TIP_STATE_ERROR_SIGNAL not in output
    assert json.loads(state_path.read_text()) == {
        "version": 1,
        "source": wallet_tip.DEFAULT_TARGET,
        "wallet": {"height": 3480000, "since": NOW},
        "upstream": {"height": 3480001, "since": NOW},
        "progress": {
            "wallet": {"height": 3480000, "since": NOW},
            "upstream": {"height": 3480001, "since": NOW},
        },
        "alerting": False,
    }


def test_reorg_resets_staleness_clock_and_recovery_is_observable():
    previous = {
        "version": 1,
        "source": wallet_tip.DEFAULT_TARGET,
        "wallet": {"height": 3480000, "since": NOW - 5000},
        "upstream": {"height": 3480000, "since": NOW - 5000},
    }
    lines, state = wallet_tip.evaluate(
        3479998, 3479998, NOW, previous, stale_seconds=1200
    )
    assert any(line.startswith(wallet_tip.WALLET_TIP_REORG_LINE) for line in lines)
    assert not any(line.startswith(wallet_tip.WALLET_TIP_STALE_SIGNAL) for line in lines)
    assert state["wallet"]["since"] == NOW


def test_provider_source_change_discards_old_baseline():
    previous = {
        "version": 1,
        "source": "old-provider:443",
        "wallet": {"height": 3480000, "since": NOW - 5000},
        "upstream": {"height": 3480000, "since": NOW - 5000},
    }
    lines, state = wallet_tip.evaluate(
        3480000, 3480000, NOW, previous, source="new-provider:443",
        stale_seconds=1200,
    )

    assert not any(line.startswith(wallet_tip.WALLET_TIP_STALE_SIGNAL) for line in lines)
    assert state["source"] == "new-provider:443"
    assert state["wallet"]["since"] == NOW
    assert state["upstream"]["since"] == NOW


def test_height_advance_clears_stale_signal_and_logs_recovery():
    previous = {
        "version": 1,
        "source": wallet_tip.DEFAULT_TARGET,
        "wallet": {"height": 3480000, "since": NOW - 5000},
        "upstream": {"height": 3480000, "since": NOW - 5000},
        "alerting": True,
    }
    lines, _state = wallet_tip.evaluate(
        3480001, 3480001, NOW, previous, stale_seconds=1200
    )
    assert any(line.startswith(wallet_tip.WALLET_TIP_RECOVERED_LINE) for line in lines)
    assert not any(line.startswith(wallet_tip.WALLET_TIP_STALE_SIGNAL) for line in lines)


def test_fresh_height_advance_does_not_log_recovery():
    previous = {
        "version": 1,
        "source": wallet_tip.DEFAULT_TARGET,
        "wallet": {"height": 3480000, "since": NOW - 10},
        "upstream": {"height": 3480000, "since": NOW - 10},
    }
    lines, _state = wallet_tip.evaluate(
        3480001, 3480001, NOW, previous, stale_seconds=1200
    )
    assert not any(line.startswith(wallet_tip.WALLET_TIP_RECOVERED_LINE) for line in lines)


def test_wallet_height_stale_while_upstream_advances_is_reported():
    previous = {
        "version": 1,
        "source": wallet_tip.DEFAULT_TARGET,
        "wallet": {"height": 3480000, "since": NOW - 1201},
        "upstream": {"height": 3480000, "since": NOW - 10},
    }
    lines, _state = wallet_tip.evaluate(
        3480000, 3480001, NOW, previous, stale_seconds=1200
    )
    assert any(line.startswith(wallet_tip.WALLET_TIP_STALE_SIGNAL) for line in lines)


def test_repeated_reorg_reversals_cannot_reset_sustained_progress_clock():
    previous = {
        "version": 1,
        "source": wallet_tip.DEFAULT_TARGET,
        "wallet": {"height": 3480000, "since": NOW},
        "upstream": {"height": 3480000, "since": NOW},
        "progress": {
            "wallet": {"height": 3480000, "since": NOW},
            "upstream": {"height": 3480000, "since": NOW},
        },
    }

    # Both heights reverse every cycle, so the ordinary observation clocks are
    # reset on every call. Only the sustained-progress clock can make the
    # final observation stale; an aged wallet clock must not mask a regression
    # in the reorg handling.
    for offset in (10, 20, 30, 40, 50):
        height = 3479999 if offset % 20 else 3480000
        lines, previous = wallet_tip.evaluate(
            height,
            height,
            NOW + offset,
            previous,
            stale_seconds=50,
        )

    assert any(line.startswith(wallet_tip.WALLET_TIP_STALE_SIGNAL) for line in lines)
    assert previous["wallet"]["since"] == NOW + 50
    assert previous["upstream"]["since"] == NOW + 50
    assert previous["progress"]["wallet"]["since"] == NOW
    assert previous["progress"]["upstream"]["since"] == NOW


def test_state_is_atomic_and_survives_round_trip(tmp_path):
    path = tmp_path / "state" / "wallet-tip.json"
    state = {
        "version": 1,
        "source": "zec.rocks:443",
        "wallet": {"height": 1, "since": NOW},
        "upstream": {"height": 2, "since": NOW},
    }
    assert wallet_tip.write_state(state, path) is None
    assert json.loads(path.read_text()) == state
    assert wallet_tip.read_state(path) == (state, None)


def test_frozen_observer_endpoint_while_wallet_advances_is_not_a_stale_page():
    # The observer's GetLatestBlock is frozen, but the wallet keeps syncing
    # past it. Crediting is current, so this must not emit the page-tier STALE
    # line; it is an email-tier provider error about the observer instead.
    previous = None
    for cycle in range(16):
        lines, previous = wallet_tip.evaluate(
            3480000 + cycle, 3480000, NOW + 90 * cycle, previous,
            stale_seconds=1200,
        )
    assert not any(
        line.startswith(wallet_tip.WALLET_TIP_STALE_SIGNAL) for line in lines
    )
    assert any(
        line.startswith(wallet_tip.WALLET_TIP_PROVIDER_ERROR_SIGNAL)
        and "not measuring the sync provider" in line
        for line in lines
    )
    assert previous["alerting"] is False


def test_frozen_provider_serving_both_sync_and_observer_still_pages():
    # Control for the test above: when the wallet froze too, it is the real
    # stale-provider incident and must still reach the STALE page.
    previous = None
    for cycle in range(20):
        height = 3480000 + min(cycle, 2)
        lines, previous = wallet_tip.evaluate(
            height, height, NOW + 90 * cycle, previous, stale_seconds=1200,
        )
    assert any(
        line.startswith(wallet_tip.WALLET_TIP_STALE_SIGNAL) for line in lines
    )
