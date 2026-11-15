# Historical membership recovery apply

`restore_refused_memberships` grants one ordinary 30-day term for each
membership named in a decision file. It does not debit, credit, transfer,
change `last_charged_at`, change `max_price`, or raise a funding cap. This is
the historical path for terminal funding refusals in
[issue #1485](https://github.com/free2z/zuu/issues/1485). The live renewal
task does not use this command, and a caller-supplied SQLSTATE is not proof.

The default is a dry run. The command locks and revalidates the current rows
in one repeatable transaction, rolls back, and prints one JSON receipt.
`can_apply` is true only when every row is eligible. A dry run exits 0 when
the receipt was produced, including when `can_apply` is false.

`--apply` writes only when the environment variable
`MEMBERSHIP_RECOVERY_APPLY` is exactly `1` and `--decision-id` equals the
file's `decision_id`. Apply is all or nothing. If any selected row conflicts,
or would still be expired after 30 days, the command writes nothing and exits
non-zero. Otherwise it calls the existing zero-charge continuation writer and,
after commit, schedules the ordinary next renewal at the new expiry minus 24
hours.

The decision file is an operator artifact. Real account identifiers,
usernames, balances, and evidence files stay outside this repository. This
document does not claim that a production cohort has been restored.
