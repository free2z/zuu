-- Structural wallet database fixture: DDL only, no account or note rows.
CREATE TABLE schemer_migrations (
                        id blob PRIMARY KEY
                    );
CREATE TABLE blocks (
                height INTEGER PRIMARY KEY,
                hash BLOB NOT NULL,
                time INTEGER NOT NULL,
                sapling_tree BLOB NOT NULL
            , sapling_commitment_tree_size INTEGER, orchard_commitment_tree_size INTEGER, sapling_output_count INTEGER, orchard_action_count INTEGER, ironwood_commitment_tree_size INTEGER, ironwood_action_count INTEGER);
CREATE TABLE sapling_tree_shards (
                shard_index INTEGER PRIMARY KEY,
                subtree_end_height INTEGER,
                root_hash BLOB,
                shard_data BLOB,
                contains_marked INTEGER,
                CONSTRAINT root_unique UNIQUE (root_hash)
            );
CREATE TABLE sapling_tree_cap (
                -- cap_id exists only to be able to take advantage of `ON CONFLICT`
                -- upsert functionality; the table will only ever contain one row
                cap_id INTEGER PRIMARY KEY,
                cap_data BLOB NOT NULL
            );
CREATE TABLE sapling_tree_checkpoints (
                checkpoint_id INTEGER PRIMARY KEY,
                position INTEGER
            );
CREATE TABLE sapling_tree_checkpoint_marks_removed (
                checkpoint_id INTEGER NOT NULL,
                mark_removed_position INTEGER NOT NULL,
                FOREIGN KEY (checkpoint_id) REFERENCES sapling_tree_checkpoints(checkpoint_id)
                ON DELETE CASCADE,
                CONSTRAINT spend_position_unique UNIQUE (checkpoint_id, mark_removed_position)
            );
CREATE TABLE scan_queue (
                block_range_start INTEGER NOT NULL,
                block_range_end INTEGER NOT NULL,
                priority INTEGER NOT NULL,
                CONSTRAINT range_start_uniq UNIQUE (block_range_start),
                CONSTRAINT range_end_uniq UNIQUE (block_range_end),
                CONSTRAINT range_bounds_order CHECK (
                    block_range_start < block_range_end
                )
            );
CREATE VIEW v_sapling_shard_scan_ranges AS
                SELECT
                    shard.shard_index,
                    shard.shard_index << 16 AS start_position,
                    (shard.shard_index + 1) << 16 AS end_position_exclusive,
                    IFNULL(prev_shard.subtree_end_height, 419200) AS subtree_start_height,
                    shard.subtree_end_height,
                    shard.contains_marked,
                    scan_queue.block_range_start,
                    scan_queue.block_range_end,
                    scan_queue.priority
                FROM sapling_tree_shards shard
                LEFT OUTER JOIN sapling_tree_shards prev_shard
                    ON shard.shard_index = prev_shard.shard_index + 1
                -- Join with scan ranges that overlap with the subtree's involved blocks.
                INNER JOIN scan_queue ON (
                    subtree_start_height < scan_queue.block_range_end AND
                    (
                        scan_queue.block_range_start <= shard.subtree_end_height OR
                        shard.subtree_end_height IS NULL
                    )
                )
/* v_sapling_shard_scan_ranges(shard_index,start_position,end_position_exclusive,subtree_start_height,subtree_end_height,contains_marked,block_range_start,block_range_end,priority) */;
CREATE VIEW v_sapling_shard_unscanned_ranges AS
                WITH wallet_birthday AS (SELECT MIN(birthday_height) AS height FROM accounts)
                SELECT
                    shard_index,
                    start_position,
                    end_position_exclusive,
                    subtree_start_height,
                    subtree_end_height,
                    contains_marked,
                    block_range_start,
                    block_range_end,
                    priority
                FROM v_sapling_shard_scan_ranges
                INNER JOIN wallet_birthday
                WHERE priority > 10
                AND block_range_end > wallet_birthday.height
/* v_sapling_shard_unscanned_ranges(shard_index,start_position,end_position_exclusive,subtree_start_height,subtree_end_height,contains_marked,block_range_start,block_range_end,priority) */;
CREATE VIEW v_sapling_shards_scan_state AS
            SELECT
                shard_index,
                start_position,
                end_position_exclusive,
                subtree_start_height,
                subtree_end_height,
                contains_marked,
                MAX(priority) AS max_priority
            FROM v_sapling_shard_scan_ranges
            GROUP BY
                shard_index,
                start_position,
                end_position_exclusive,
                subtree_start_height,
                subtree_end_height,
                contains_marked
/* v_sapling_shards_scan_state(shard_index,start_position,end_position_exclusive,subtree_start_height,subtree_end_height,contains_marked,max_priority) */;
CREATE TABLE orchard_tree_shards (
                shard_index INTEGER PRIMARY KEY,
                subtree_end_height INTEGER,
                root_hash BLOB,
                shard_data BLOB,
                contains_marked INTEGER,
                CONSTRAINT root_unique UNIQUE (root_hash)
            );
CREATE TABLE orchard_tree_cap (
                -- cap_id exists only to be able to take advantage of `ON CONFLICT`
                -- upsert functionality; the table will only ever contain one row
                cap_id INTEGER PRIMARY KEY,
                cap_data BLOB NOT NULL
            );
CREATE TABLE orchard_tree_checkpoints (
                checkpoint_id INTEGER PRIMARY KEY,
                position INTEGER
            );
CREATE TABLE orchard_tree_checkpoint_marks_removed (
                checkpoint_id INTEGER NOT NULL,
                mark_removed_position INTEGER NOT NULL,
                FOREIGN KEY (checkpoint_id) REFERENCES orchard_tree_checkpoints(checkpoint_id)
                ON DELETE CASCADE,
                CONSTRAINT spend_position_unique UNIQUE (checkpoint_id, mark_removed_position)
            );
CREATE VIEW v_orchard_shard_scan_ranges AS
                SELECT
                    shard.shard_index,
                    shard.shard_index << 16 AS start_position,
                    (shard.shard_index + 1) << 16 AS end_position_exclusive,
                    IFNULL(prev_shard.subtree_end_height, 1687104) AS subtree_start_height,
                    shard.subtree_end_height,
                    shard.contains_marked,
                    scan_queue.block_range_start,
                    scan_queue.block_range_end,
                    scan_queue.priority
                FROM orchard_tree_shards shard
                LEFT OUTER JOIN orchard_tree_shards prev_shard
                    ON shard.shard_index = prev_shard.shard_index + 1
                -- Join with scan ranges that overlap with the subtree's involved blocks.
                INNER JOIN scan_queue ON (
                    subtree_start_height < scan_queue.block_range_end AND
                    (
                        scan_queue.block_range_start <= shard.subtree_end_height OR
                        shard.subtree_end_height IS NULL
                    )
                )
/* v_orchard_shard_scan_ranges(shard_index,start_position,end_position_exclusive,subtree_start_height,subtree_end_height,contains_marked,block_range_start,block_range_end,priority) */;
CREATE VIEW v_orchard_shard_unscanned_ranges AS
                WITH wallet_birthday AS (SELECT MIN(birthday_height) AS height FROM accounts)
                SELECT
                    shard_index,
                    start_position,
                    end_position_exclusive,
                    subtree_start_height,
                    subtree_end_height,
                    contains_marked,
                    block_range_start,
                    block_range_end,
                    priority
                FROM v_orchard_shard_scan_ranges
                INNER JOIN wallet_birthday
                WHERE priority > 10
                AND block_range_end > wallet_birthday.height
/* v_orchard_shard_unscanned_ranges(shard_index,start_position,end_position_exclusive,subtree_start_height,subtree_end_height,contains_marked,block_range_start,block_range_end,priority) */;
CREATE VIEW v_orchard_shards_scan_state AS
            SELECT
                shard_index,
                start_position,
                end_position_exclusive,
                subtree_start_height,
                subtree_end_height,
                contains_marked,
                MAX(priority) AS max_priority
            FROM v_orchard_shard_scan_ranges
            GROUP BY
                shard_index,
                start_position,
                end_position_exclusive,
                subtree_start_height,
                subtree_end_height,
                contains_marked
/* v_orchard_shards_scan_state(shard_index,start_position,end_position_exclusive,subtree_start_height,subtree_end_height,contains_marked,max_priority) */;
CREATE TABLE tx_locator_map (
                block_height INTEGER NOT NULL,
                tx_index INTEGER NOT NULL,
                txid BLOB NOT NULL UNIQUE,
                PRIMARY KEY (block_height, tx_index)
            );
CREATE TABLE nullifier_map (
                spend_pool INTEGER NOT NULL,
                nf BLOB NOT NULL,
                block_height INTEGER NOT NULL,
                tx_index INTEGER NOT NULL,
                CONSTRAINT tx_locator
                    FOREIGN KEY (block_height, tx_index)
                    REFERENCES tx_locator_map(block_height, tx_index)
                    ON DELETE CASCADE
                    ON UPDATE RESTRICT,
                CONSTRAINT nf_uniq UNIQUE (spend_pool, nf)
            );
CREATE INDEX nf_map_locator_idx ON nullifier_map(block_height, tx_index);
CREATE VIEW v_address_first_use AS
            SELECT
                address_id,
                account_id,
                key_scope,
                diversifier_index_be,
                transparent_child_index,
                MIN(mined_height) AS first_use_height
            FROM v_address_uses
            GROUP BY
                address_id, account_id, key_scope,
                diversifier_index_be, transparent_child_index
/* v_address_first_use(address_id,account_id,key_scope,diversifier_index_be,transparent_child_index,first_use_height) */;
CREATE TABLE IF NOT EXISTS "transactions" (
                id_tx INTEGER PRIMARY KEY,
                txid BLOB NOT NULL UNIQUE,
                created TEXT,
                block INTEGER,
                mined_height INTEGER,
                tx_index INTEGER,
                expiry_height INTEGER,
                raw BLOB,
                fee INTEGER,
                target_height INTEGER,
                min_observed_height INTEGER NOT NULL,
                confirmed_unmined_at_height INTEGER, trust_status INTEGER,
                FOREIGN KEY (block) REFERENCES blocks(height),
                CONSTRAINT height_consistency CHECK (
                    block IS NULL OR mined_height = block
                ),
                CONSTRAINT min_observed_consistency CHECK (
                    mined_height IS NULL OR min_observed_height <= mined_height
                ),
                CONSTRAINT confirmed_unmined_consistency CHECK (
                    confirmed_unmined_at_height IS NULL OR mined_height IS NULL
                )
            );
CREATE TABLE IF NOT EXISTS "sapling_received_notes" (
                id INTEGER PRIMARY KEY,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                output_index INTEGER NOT NULL,
                account_id INTEGER NOT NULL
                    REFERENCES accounts(id) ON DELETE CASCADE,
                diversifier BLOB NOT NULL,
                value INTEGER NOT NULL,
                rcm BLOB NOT NULL,
                nf BLOB UNIQUE,
                is_change INTEGER NOT NULL,
                memo BLOB,
                commitment_tree_position INTEGER,
                recipient_key_scope INTEGER,
                address_id INTEGER
                    REFERENCES addresses(id) ON DELETE CASCADE, witness_stabilized INTEGER NOT NULL DEFAULT 0,
                UNIQUE (transaction_id, output_index)
            );
CREATE INDEX idx_sapling_received_notes_account ON sapling_received_notes (account_id ASC);
CREATE INDEX idx_sapling_received_notes_address ON sapling_received_notes (address_id ASC);
CREATE INDEX idx_sapling_received_notes_tx ON sapling_received_notes (transaction_id ASC);
CREATE TABLE IF NOT EXISTS "sapling_received_note_spends" (
                sapling_received_note_id INTEGER NOT NULL
                    REFERENCES sapling_received_notes(id) ON DELETE CASCADE,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                UNIQUE (sapling_received_note_id, transaction_id)
            );
CREATE INDEX idx_sapling_received_note_spends_note_id ON sapling_received_note_spends (sapling_received_note_id ASC);
CREATE INDEX idx_sapling_received_note_spends_transaction_id ON sapling_received_note_spends (transaction_id ASC);
CREATE TABLE IF NOT EXISTS "orchard_received_notes" (
                id INTEGER PRIMARY KEY,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                action_index INTEGER NOT NULL,
                account_id INTEGER NOT NULL
                    REFERENCES accounts(id) ON DELETE CASCADE,
                diversifier BLOB NOT NULL,
                value INTEGER NOT NULL,
                rho BLOB NOT NULL,
                rseed BLOB NOT NULL,
                nf BLOB UNIQUE,
                is_change INTEGER NOT NULL,
                memo BLOB,
                commitment_tree_position INTEGER,
                recipient_key_scope INTEGER,
                address_id INTEGER
                    REFERENCES addresses(id) ON DELETE CASCADE, witness_stabilized INTEGER NOT NULL DEFAULT 0, note_version INTEGER NOT NULL DEFAULT 2,
                UNIQUE (transaction_id, action_index)
            );
CREATE INDEX idx_orchard_received_notes_account ON orchard_received_notes (account_id ASC);
CREATE INDEX idx_orchard_received_notes_address ON orchard_received_notes (address_id ASC);
CREATE INDEX idx_orchard_received_notes_tx ON orchard_received_notes (transaction_id ASC);
CREATE TABLE IF NOT EXISTS "orchard_received_note_spends" (
                orchard_received_note_id INTEGER NOT NULL
                    REFERENCES orchard_received_notes(id) ON DELETE CASCADE,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                UNIQUE (orchard_received_note_id, transaction_id)
            );
CREATE INDEX idx_orchard_received_note_spends_note_id ON orchard_received_note_spends (orchard_received_note_id ASC);
CREATE INDEX idx_orchard_received_note_spends_transaction_id ON orchard_received_note_spends (transaction_id ASC);
CREATE TABLE IF NOT EXISTS "transparent_received_outputs" (
                id INTEGER PRIMARY KEY,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                output_index INTEGER NOT NULL,
                account_id INTEGER NOT NULL
                    REFERENCES accounts(id) ON DELETE CASCADE,
                address TEXT NOT NULL,
                script BLOB NOT NULL,
                value_zat INTEGER NOT NULL,
                max_observed_unspent_height INTEGER,
                address_id INTEGER NOT NULL
                    REFERENCES addresses(id) ON DELETE CASCADE,
                UNIQUE (transaction_id, output_index)
            );
CREATE INDEX idx_transparent_received_outputs_account ON transparent_received_outputs (account_id);
CREATE INDEX idx_transparent_received_outputs_address ON transparent_received_outputs (address_id);
CREATE INDEX idx_transparent_received_outputs_tx ON transparent_received_outputs (transaction_id);
CREATE TABLE IF NOT EXISTS "transparent_received_output_spends" (
                transparent_received_output_id INTEGER NOT NULL
                    REFERENCES transparent_received_outputs(id) ON DELETE CASCADE,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                UNIQUE (transparent_received_output_id, transaction_id)
            );
CREATE INDEX idx_transparent_received_output_spends_output_id ON transparent_received_output_spends (transparent_received_output_id ASC);
CREATE INDEX idx_transparent_received_output_spends_transaction_id ON transparent_received_output_spends (transaction_id ASC);
CREATE TABLE IF NOT EXISTS "transparent_spend_map" (
                spending_transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                prevout_txid BLOB NOT NULL,
                prevout_output_index INTEGER NOT NULL,
                -- NOTE: We can't create a unique constraint on just (prevout_txid, prevout_output_index)
                -- because the same output may be attempted to be spent in multiple transactions, even
                -- though only one will ever be mined.
                UNIQUE (spending_transaction_id, prevout_txid, prevout_output_index)
            );
CREATE INDEX idx_transparent_spend_map_transaction_id ON transparent_spend_map (spending_transaction_id ASC);
CREATE TABLE IF NOT EXISTS "sent_notes" (
                id INTEGER PRIMARY KEY,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                output_pool INTEGER NOT NULL,
                output_index INTEGER NOT NULL,
                from_account_id INTEGER NOT NULL
                    REFERENCES accounts(id) ON DELETE CASCADE,
                to_address TEXT,
                to_account_id INTEGER
                    REFERENCES accounts(id) ON DELETE SET NULL,
                value INTEGER NOT NULL,
                memo BLOB,
                UNIQUE (transaction_id, output_pool, output_index)
            );
CREATE INDEX idx_sent_notes_from_account ON sent_notes (from_account_id);
CREATE INDEX idx_sent_notes_to_account ON sent_notes (to_account_id);
CREATE INDEX idx_sent_notes_transaction_id ON sent_notes (transaction_id);
CREATE TABLE IF NOT EXISTS "tx_retrieval_queue" (
                txid BLOB NOT NULL UNIQUE,
                query_type INTEGER NOT NULL,
                dependent_transaction_id INTEGER
                    REFERENCES transactions(id_tx) ON DELETE CASCADE
            );
CREATE INDEX idx_tx_retrieval_queue_dependent_tx ON tx_retrieval_queue (dependent_transaction_id);
CREATE TABLE IF NOT EXISTS "transparent_spend_search_queue" (
                address TEXT NOT NULL,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                output_index INTEGER NOT NULL,
                UNIQUE (transaction_id, output_index)
            );
CREATE INDEX idx_tssq_transaction_id ON transparent_spend_search_queue (transaction_id);
CREATE VIEW v_transactions AS
            WITH
            notes AS (
                -- Outputs received in this transaction
                SELECT ro.account_id              AS account_id,
                       ro.transaction_id          AS transaction_id,
                       ro.pool                    AS pool,
                       id_within_pool_table,
                       ro.value                   AS value,
                       ro.value                   AS received_value,
                       0                          AS spent_value,
                       0                          AS spent_note_count,
                       CASE
                            WHEN ro.is_change THEN 1
                            ELSE 0
                       END AS change_note_count,
                       CASE
                            WHEN ro.is_change THEN 0
                            ELSE 1
                       END AS received_count,
                       CASE
                         WHEN (ro.memo IS NULL OR ro.memo = X'F6')
                           THEN 0
                         ELSE 1
                       END AS memo_present,
                       -- The wallet cannot receive transparent outputs in shielding transactions.
                       CASE
                         WHEN ro.pool = 0
                           THEN 1
                         ELSE 0
                       END AS does_not_match_shielding
                FROM v_received_outputs ro
                UNION
                -- Outputs spent in this transaction
                SELECT ro.account_id              AS account_id,
                       ros.transaction_id         AS transaction_id,
                       ro.pool                    AS pool,
                       id_within_pool_table,
                       -ro.value                  AS value,
                       0                          AS received_value,
                       ro.value                   AS spent_value,
                       1                          AS spent_note_count,
                       0                          AS change_note_count,
                       0                          AS received_count,
                       0                          AS memo_present,
                       -- The wallet cannot spend shielded outputs in shielding transactions.
                       CASE
                         WHEN ro.pool != 0
                           THEN 1
                         ELSE 0
                       END AS does_not_match_shielding
                FROM v_received_outputs ro
                JOIN v_received_output_spends ros
                     ON ros.pool = ro.pool
                     AND ros.received_output_id = ro.id_within_pool_table
            ),
            -- Obtain a count of the notes that the wallet created in each transaction,
            -- not counting change notes.
            sent_note_counts AS (
                SELECT sent_notes.from_account_id     AS account_id,
                       sent_notes.transaction_id      AS transaction_id,
                       COUNT(DISTINCT sent_notes.id)  AS sent_notes,
                       SUM(
                         CASE
                           WHEN (sent_notes.memo IS NULL OR sent_notes.memo = X'F6' OR ro.transaction_id IS NOT NULL)
                             THEN 0
                           ELSE 1
                         END
                       ) AS memo_count
                FROM sent_notes
                LEFT JOIN v_received_outputs ro ON sent_notes.id = ro.sent_note_id
                WHERE COALESCE(ro.is_change, 0) = 0
                GROUP BY account_id, sent_notes.transaction_id
            ),
            blocks_max_height AS (
                SELECT MAX(blocks.height) AS max_height FROM blocks
            )
            SELECT accounts.uuid                AS account_uuid,
                   transactions.mined_height    AS mined_height,
                   transactions.txid            AS txid,
                   transactions.tx_index        AS tx_index,
                   transactions.expiry_height   AS expiry_height,
                   transactions.raw             AS raw,
                   SUM(notes.value)             AS account_balance_delta,
                   SUM(notes.spent_value)       AS total_spent,
                   SUM(notes.received_value)    AS total_received,
                   transactions.fee             AS fee_paid,
                   SUM(notes.change_note_count) > 0  AS has_change,
                   MAX(COALESCE(sent_note_counts.sent_notes, 0))  AS sent_note_count,
                   SUM(notes.received_count)         AS received_note_count,
                   SUM(notes.memo_present) + MAX(COALESCE(sent_note_counts.memo_count, 0)) AS memo_count,
                   blocks.time                       AS block_time,
                   (
                        transactions.mined_height IS NULL
                        AND transactions.expiry_height BETWEEN 1 AND blocks_max_height.max_height
                   ) AS expired_unmined,
                   SUM(notes.spent_note_count) AS spent_note_count,
                   (
                        -- All of the wallet-spent and wallet-received notes are consistent with a
                        -- shielding transaction.
                        SUM(notes.does_not_match_shielding) = 0
                        -- The transaction contains at least one wallet-spent output.
                        AND SUM(notes.spent_note_count) > 0
                        -- The transaction contains at least one wallet-received note.
                        AND (SUM(notes.received_count) + SUM(notes.change_note_count)) > 0
                        -- We do not know about any external outputs of the transaction.
                        AND MAX(COALESCE(sent_note_counts.sent_notes, 0)) = 0
                   ) AS is_shielding,
                   transactions.trust_status
            FROM notes
            JOIN accounts ON accounts.id = notes.account_id
            JOIN transactions ON transactions.id_tx = notes.transaction_id
            LEFT JOIN blocks_max_height
            LEFT JOIN blocks ON blocks.height = transactions.mined_height
            LEFT JOIN sent_note_counts
                 ON sent_note_counts.account_id = notes.account_id
                 AND sent_note_counts.transaction_id = notes.transaction_id
            GROUP BY notes.account_id, notes.transaction_id
/* v_transactions(account_uuid,mined_height,txid,tx_index,expiry_height,raw,account_balance_delta,total_spent,total_received,fee_paid,has_change,sent_note_count,received_note_count,memo_count,block_time,expired_unmined,spent_note_count,is_shielding,trust_status) */;
CREATE VIEW v_address_uses AS
                SELECT orn.address_id, orn.account_id, orn.transaction_id, t.mined_height,
                       a.key_scope, a.diversifier_index_be, a.transparent_child_index
                FROM orchard_received_notes orn
                JOIN addresses a ON a.id = orn.address_id
                JOIN transactions t ON t.id_tx = orn.transaction_id
            UNION
                SELECT srn.address_id, srn.account_id, srn.transaction_id, t.mined_height,
                       a.key_scope, a.diversifier_index_be, a.transparent_child_index
                FROM sapling_received_notes srn
                JOIN addresses a ON a.id = srn.address_id
                JOIN transactions t ON t.id_tx = srn.transaction_id
            UNION
                SELECT tro.address_id, tro.account_id, tro.transaction_id, t.mined_height,
                       a.key_scope, a.diversifier_index_be, a.transparent_child_index
                FROM transparent_received_outputs tro
                JOIN addresses a ON a.id = tro.address_id
                JOIN transactions t ON t.id_tx = tro.transaction_id
/* v_address_uses(address_id,account_id,transaction_id,mined_height,key_scope,diversifier_index_be,transparent_child_index) */;
CREATE VIEW v_tx_outputs AS
            WITH unioned AS (
                -- select all outputs received by the wallet
                SELECT t.id_tx                      AS transaction_id,
                       t.txid                       AS txid,
                       t.mined_height               AS mined_height,
                       IFNULL(t.trust_status, 0)    AS trust_status,
                       ro.pool                      AS output_pool,
                       ro.output_index              AS output_index,
                       from_account.uuid            AS from_account_uuid,
                       to_account.uuid              AS to_account_uuid,
                       a.address                    AS to_address,
                       a.diversifier_index_be       AS diversifier_index_be,
                       ro.value                     AS value,
                       ro.is_change                 AS is_change,
                       ro.memo                      AS memo,
                       a.key_scope                  AS recipient_key_scope
                FROM v_received_outputs ro
                JOIN transactions t
                    ON t.id_tx = ro.transaction_id
                LEFT JOIN addresses a ON a.id = ro.address_id
                -- join to the sent_notes table to obtain `from_account_id`
                LEFT JOIN sent_notes ON sent_notes.id = ro.sent_note_id
                -- join on the accounts table to obtain account UUIDs
                LEFT JOIN accounts from_account ON from_account.id = sent_notes.from_account_id
                LEFT JOIN accounts to_account ON to_account.id = ro.account_id
                UNION ALL
                -- select all outputs sent from the wallet to external recipients
                SELECT t.id_tx                      AS transaction_id,
                       t.txid                       AS txid,
                       t.mined_height               AS mined_height,
                       IFNULL(t.trust_status, 0)    AS trust_status,
                       sent_notes.output_pool       AS output_pool,
                       sent_notes.output_index      AS output_index,
                       from_account.uuid            AS from_account_uuid,
                       NULL                         AS to_account_uuid,
                       sent_notes.to_address        AS to_address,
                       NULL                         AS diversifier_index_be,
                       sent_notes.value             AS value,
                       0                            AS is_change,
                       sent_notes.memo              AS memo,
                       NULL                         AS recipient_key_scope
                FROM sent_notes
                JOIN transactions t
                    ON t.id_tx = sent_notes.transaction_id
                LEFT JOIN v_received_outputs ro ON ro.sent_note_id = sent_notes.id
                -- join on the accounts table to obtain account UUIDs
                LEFT JOIN accounts from_account ON from_account.id = sent_notes.from_account_id
            )
            -- merge duplicate rows while retaining maximum information
            SELECT
                transaction_id,
                MAX(txid)                   AS txid,
                MAX(mined_height)           AS tx_mined_height,
                MIN(trust_status)           AS tx_trust_status,
                output_pool,
                output_index,
                MAX(from_account_uuid)      AS from_account_uuid,
                MAX(to_account_uuid)        AS to_account_uuid,
                MAX(to_address)             AS to_address,
                MAX(value)                  AS value,
                MAX(is_change)              AS is_change,
                MAX(memo)                   AS memo,
                MAX(recipient_key_scope)    AS recipient_key_scope
            FROM unioned
            GROUP BY transaction_id, output_pool, output_index
/* v_tx_outputs(transaction_id,txid,tx_mined_height,tx_trust_status,output_pool,output_index,from_account_uuid,to_account_uuid,to_address,value,is_change,memo,recipient_key_scope) */;
CREATE TABLE IF NOT EXISTS "addresses" (
                id INTEGER NOT NULL PRIMARY KEY,
                account_id INTEGER NOT NULL
                    REFERENCES accounts(id) ON DELETE CASCADE,
                key_scope INTEGER NOT NULL,
                diversifier_index_be BLOB,
                address TEXT NOT NULL,
                transparent_child_index INTEGER,
                cached_transparent_receiver_address TEXT,
                exposed_at_height INTEGER,
                receiver_flags INTEGER NOT NULL,
                transparent_receiver_next_check_time INTEGER,
                imported_transparent_receiver_pubkey BLOB,
                imported_transparent_receiver_script BLOB,
                UNIQUE (account_id, key_scope, diversifier_index_be),
                UNIQUE (imported_transparent_receiver_pubkey),
                UNIQUE (imported_transparent_receiver_script),
                CONSTRAINT ck_addr_transparent_index_consistency CHECK (
                    (transparent_child_index IS NULL OR diversifier_index_be < x'0000000F00000000000000')
                    AND (
                        (
                            cached_transparent_receiver_address IS NULL
                            AND transparent_child_index IS NULL
                            AND imported_transparent_receiver_pubkey IS NULL
                            AND imported_transparent_receiver_script IS NULL
                        )
                        OR (
                            cached_transparent_receiver_address IS NOT NULL
                            AND (
                                (transparent_child_index IS NULL) == (
                                    key_scope = -1 AND (
                                        (imported_transparent_receiver_pubkey IS NULL) !=
                                          (imported_transparent_receiver_script IS NULL)
                                    )
                                )
                            )
                        )
                    )
                ),
                CONSTRAINT ck_addr_foreign_or_diversified CHECK (
                    (diversifier_index_be IS NULL) == (key_scope = -1)
                )
            );
CREATE INDEX idx_addresses_accounts ON addresses (
                account_id ASC
            );
CREATE INDEX idx_addresses_indices ON addresses (
                diversifier_index_be ASC
            );
CREATE INDEX idx_addresses_pubkeys ON addresses (
                imported_transparent_receiver_pubkey ASC
            );
CREATE INDEX idx_addresses_t_indices ON addresses (
                transparent_child_index ASC
            );
CREATE TABLE IF NOT EXISTS "accounts" (
                id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                uuid BLOB NOT NULL,
                account_kind INTEGER NOT NULL DEFAULT 0,
                key_source TEXT,
                hd_seed_fingerprint BLOB,
                hd_account_index INTEGER,
                ufvk TEXT,
                uivk TEXT NOT NULL,
                orchard_ivk_item_cache BLOB,
                sapling_ivk_item_cache BLOB,
                p2pkh_ivk_item_cache BLOB,
                p2sh_ivk_item_cache BLOB,
                birthday_height INTEGER NOT NULL,
                birthday_sapling_tree_size INTEGER,
                birthday_orchard_tree_size INTEGER,
                recover_until_height INTEGER,
                has_spend_key INTEGER NOT NULL DEFAULT 1,
                zcashd_legacy_address_index INTEGER NOT NULL DEFAULT -1,
                CHECK (
                  (
                    account_kind = 0
                    AND hd_seed_fingerprint IS NOT NULL
                    AND hd_account_index IS NOT NULL
                    AND ufvk IS NOT NULL
                  )
                  OR
                  (
                    account_kind = 1
                    AND (hd_seed_fingerprint IS NULL) = (hd_account_index IS NULL)
                  )
                ),
                CHECK (
                  NOT (p2pkh_ivk_item_cache IS NOT NULL AND p2sh_ivk_item_cache IS NOT NULL)
                )
            );
CREATE UNIQUE INDEX accounts_uuid ON accounts (uuid);
CREATE UNIQUE INDEX accounts_ufvk ON accounts (ufvk);
CREATE UNIQUE INDEX accounts_uivk ON accounts (uivk);
CREATE UNIQUE INDEX hd_account ON accounts (hd_seed_fingerprint, hd_account_index, zcashd_legacy_address_index);
CREATE UNIQUE INDEX accounts_orchard_ivk ON accounts (orchard_ivk_item_cache);
CREATE UNIQUE INDEX accounts_sapling_ivk ON accounts (sapling_ivk_item_cache);
CREATE UNIQUE INDEX accounts_p2pkh_ivk ON accounts (p2pkh_ivk_item_cache);
CREATE UNIQUE INDEX accounts_p2sh_ivk ON accounts (p2sh_ivk_item_cache);
CREATE UNIQUE INDEX idx_addresses_cached_transparent_receiver_address
                 ON addresses (cached_transparent_receiver_address ASC);
CREATE INDEX idx_transparent_received_outputs_value_zat
                 ON transparent_received_outputs (value_zat DESC);
CREATE TABLE ironwood_tree_shards (
                shard_index INTEGER PRIMARY KEY,
                subtree_end_height INTEGER,
                root_hash BLOB,
                shard_data BLOB,
                contains_marked INTEGER,
                CONSTRAINT root_unique UNIQUE (root_hash)
            );
CREATE TABLE ironwood_tree_cap (
                -- cap_id exists only to be able to take advantage of `ON CONFLICT`
                -- upsert functionality; the table will only ever contain one row
                cap_id INTEGER PRIMARY KEY,
                cap_data BLOB NOT NULL
            );
CREATE TABLE ironwood_tree_checkpoints (
                checkpoint_id INTEGER PRIMARY KEY,
                position INTEGER
            );
CREATE TABLE ironwood_tree_checkpoint_marks_removed (
                checkpoint_id INTEGER NOT NULL,
                mark_removed_position INTEGER NOT NULL,
                FOREIGN KEY (checkpoint_id) REFERENCES ironwood_tree_checkpoints(checkpoint_id)
                ON DELETE CASCADE,
                CONSTRAINT spend_position_unique UNIQUE (checkpoint_id, mark_removed_position)
            );
CREATE TABLE ironwood_tree_retained_checkpoints (
                checkpoint_id INTEGER PRIMARY KEY
            );
CREATE VIEW v_ironwood_shard_scan_ranges AS
                SELECT
                    shard.shard_index,
                    shard.shard_index << 16 AS start_position,
                    (shard.shard_index + 1) << 16 AS end_position_exclusive,
                    IFNULL(prev_shard.subtree_end_height, 3428143) AS subtree_start_height,
                    shard.subtree_end_height,
                    shard.contains_marked,
                    scan_queue.block_range_start,
                    scan_queue.block_range_end,
                    scan_queue.priority
                FROM ironwood_tree_shards shard
                LEFT OUTER JOIN ironwood_tree_shards prev_shard
                    ON shard.shard_index = prev_shard.shard_index + 1
                -- Join with scan ranges that overlap with the subtree's involved blocks.
                INNER JOIN scan_queue ON (
                    subtree_start_height < scan_queue.block_range_end AND
                    (
                        scan_queue.block_range_start <= shard.subtree_end_height OR
                        shard.subtree_end_height IS NULL
                    )
                )
/* v_ironwood_shard_scan_ranges(shard_index,start_position,end_position_exclusive,subtree_start_height,subtree_end_height,contains_marked,block_range_start,block_range_end,priority) */;
CREATE VIEW v_ironwood_shard_unscanned_ranges AS
                WITH wallet_birthday AS (SELECT MIN(birthday_height) AS height FROM accounts)
                SELECT
                    shard_index,
                    start_position,
                    end_position_exclusive,
                    subtree_start_height,
                    subtree_end_height,
                    contains_marked,
                    block_range_start,
                    block_range_end,
                    priority
                FROM v_ironwood_shard_scan_ranges
                INNER JOIN wallet_birthday
                WHERE priority > 10
                AND block_range_end > wallet_birthday.height
/* v_ironwood_shard_unscanned_ranges(shard_index,start_position,end_position_exclusive,subtree_start_height,subtree_end_height,contains_marked,block_range_start,block_range_end,priority) */;
CREATE VIEW v_ironwood_shards_scan_state AS
            SELECT
                shard_index,
                start_position,
                end_position_exclusive,
                subtree_start_height,
                subtree_end_height,
                contains_marked,
                MAX(priority) AS max_priority
            FROM v_ironwood_shard_scan_ranges
            GROUP BY
                shard_index,
                start_position,
                end_position_exclusive,
                subtree_start_height,
                subtree_end_height,
                contains_marked
/* v_ironwood_shards_scan_state(shard_index,start_position,end_position_exclusive,subtree_start_height,subtree_end_height,contains_marked,max_priority) */;
CREATE INDEX idx_sapling_received_notes_witness_stabilized
                 ON sapling_received_notes (witness_stabilized);
CREATE INDEX idx_orchard_received_notes_witness_stabilized
                 ON orchard_received_notes (witness_stabilized);
CREATE TABLE ironwood_received_notes (
                id INTEGER PRIMARY KEY,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                action_index INTEGER NOT NULL,
                account_id INTEGER NOT NULL
                    REFERENCES accounts(id) ON DELETE CASCADE,
                diversifier BLOB NOT NULL,
                value INTEGER NOT NULL,
                rho BLOB NOT NULL,
                rseed BLOB NOT NULL,
                nf BLOB UNIQUE,
                is_change INTEGER NOT NULL,
                memo BLOB,
                commitment_tree_position INTEGER,
                recipient_key_scope INTEGER,
                address_id INTEGER
                    REFERENCES addresses(id) ON DELETE CASCADE,
                witness_stabilized INTEGER NOT NULL DEFAULT 0,
                note_version INTEGER NOT NULL,
                UNIQUE (transaction_id, action_index)
            );
CREATE INDEX idx_ironwood_received_notes_account ON ironwood_received_notes (
                account_id ASC
            );
CREATE INDEX idx_ironwood_received_notes_address ON ironwood_received_notes (
                address_id ASC
            );
CREATE INDEX idx_ironwood_received_notes_tx ON ironwood_received_notes (
                transaction_id ASC
            );
CREATE INDEX idx_ironwood_received_notes_witness_stabilized ON ironwood_received_notes (
                witness_stabilized
            );
CREATE TABLE ironwood_received_note_spends (
                ironwood_received_note_id INTEGER NOT NULL
                    REFERENCES ironwood_received_notes(id) ON DELETE CASCADE,
                transaction_id INTEGER NOT NULL
                    REFERENCES transactions(id_tx) ON DELETE CASCADE,
                UNIQUE (ironwood_received_note_id, transaction_id)
            );
CREATE INDEX idx_ironwood_received_note_spends_note_id ON ironwood_received_note_spends (
                ironwood_received_note_id ASC
            );
CREATE INDEX idx_ironwood_received_note_spends_transaction_id ON ironwood_received_note_spends (
                transaction_id ASC
            );
CREATE VIEW v_received_outputs AS
                SELECT
                    sapling_received_notes.id AS id_within_pool_table,
                    sapling_received_notes.transaction_id,
                    2 AS pool,
                    sapling_received_notes.output_index,
                    account_id,
                    sapling_received_notes.value,
                    is_change,
                    sapling_received_notes.memo,
                    sent_notes.id AS sent_note_id,
                    sapling_received_notes.address_id
                FROM sapling_received_notes
                LEFT JOIN sent_notes
                ON (sent_notes.transaction_id, sent_notes.output_pool, sent_notes.output_index) =
                   (sapling_received_notes.transaction_id, 2, sapling_received_notes.output_index)
            UNION
                SELECT
                    orchard_received_notes.id AS id_within_pool_table,
                    orchard_received_notes.transaction_id,
                    3 AS pool,
                    orchard_received_notes.action_index AS output_index,
                    account_id,
                    orchard_received_notes.value,
                    is_change,
                    orchard_received_notes.memo,
                    sent_notes.id AS sent_note_id,
                    orchard_received_notes.address_id
                FROM orchard_received_notes
                LEFT JOIN sent_notes
                ON (sent_notes.transaction_id, sent_notes.output_pool, sent_notes.output_index) =
                   (orchard_received_notes.transaction_id, 3, orchard_received_notes.action_index)
            UNION
                SELECT
                    ironwood_received_notes.id AS id_within_pool_table,
                    ironwood_received_notes.transaction_id,
                    4 AS pool,
                    ironwood_received_notes.action_index AS output_index,
                    account_id,
                    ironwood_received_notes.value,
                    is_change,
                    ironwood_received_notes.memo,
                    sent_notes.id AS sent_note_id,
                    ironwood_received_notes.address_id
                FROM ironwood_received_notes
                LEFT JOIN sent_notes
                ON (sent_notes.transaction_id, sent_notes.output_pool, sent_notes.output_index) =
                   (ironwood_received_notes.transaction_id, 4, ironwood_received_notes.action_index)
            UNION
                SELECT
                    u.id AS id_within_pool_table,
                    u.transaction_id,
                    0 AS pool,
                    u.output_index,
                    u.account_id,
                    u.value_zat AS value,
                    0 AS is_change,
                    NULL AS memo,
                    sent_notes.id AS sent_note_id,
                    u.address_id
                FROM transparent_received_outputs u
                LEFT JOIN sent_notes
                ON (sent_notes.transaction_id, sent_notes.output_pool, sent_notes.output_index) =
                   (u.transaction_id, 0, u.output_index)
/* v_received_outputs(id_within_pool_table,transaction_id,pool,output_index,account_id,value,is_change,memo,sent_note_id,address_id) */;
CREATE VIEW v_received_output_spends AS
            SELECT
                2 AS pool,
                s.sapling_received_note_id AS received_output_id,
                s.transaction_id,
                rn.account_id
            FROM sapling_received_note_spends s
            JOIN sapling_received_notes rn ON rn.id = s.sapling_received_note_id
            UNION
            SELECT
                3 AS pool,
                s.orchard_received_note_id AS received_output_id,
                s.transaction_id,
                rn.account_id
            FROM orchard_received_note_spends s
            JOIN orchard_received_notes rn ON rn.id = s.orchard_received_note_id
            UNION
            SELECT
                4 AS pool,
                s.ironwood_received_note_id AS received_output_id,
                s.transaction_id,
                rn.account_id
            FROM ironwood_received_note_spends s
            JOIN ironwood_received_notes rn ON rn.id = s.ironwood_received_note_id
            UNION
            SELECT
                0 AS pool,
                s.transparent_received_output_id AS received_output_id,
                s.transaction_id,
                rn.account_id
            FROM transparent_received_output_spends s
            JOIN transparent_received_outputs rn ON rn.id = s.transparent_received_output_id
/* v_received_output_spends(pool,received_output_id,transaction_id,account_id) */;
CREATE TABLE sapling_tree_retained_checkpoints (
                checkpoint_id INTEGER PRIMARY KEY
            );
CREATE TABLE orchard_tree_retained_checkpoints (
                checkpoint_id INTEGER PRIMARY KEY
            );
