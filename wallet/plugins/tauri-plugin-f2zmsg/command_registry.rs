// One inventory drives both Tauri's runtime invoke handler and its generated
// permission manifest. Keeping those two registrations structurally identical
// prevents a command from compiling while being unreachable or unauthorized —
// the same arrangement `tauri-plugin-zcash/command_registry.rs` uses, and for
// the same reason.
//
// The order here is `docs/e2ee/CLIENT-CONTRACT.md` §3's order, section by
// section, so a reader can hold the document and this file side by side.
//
// NOT here, deliberately: `f2zmsg_enroll`, `f2zmsg_enrollment_status` and
// `f2zmsg_unenroll`. Enrollment needs the wallet seed and lives in the app
// crate (§2.2, `wallet/zuuli/src-tauri/src/messaging.rs`); routing it through a
// plugin would put the mnemonic in the webview's JavaScript heap.
macro_rules! with_f2zmsg_commands {
    ($callback:ident) => {
        $callback! {
            // §3.1 engine lifecycle
            get_engine_status,
            start_engine,
            stop_engine,
            get_device_info,
            // §3.3 conversations and first contact
            list_conversations,
            get_conversation,
            start_conversation,
            list_contact_requests,
            accept_contact_request,
            reject_contact_request,
            leave_conversation,
            // §3.4 sending and listing
            send_message,
            retry_send,
            cancel_send,
            list_messages,
            get_message,
            // §3.6 delivery state and receipts
            get_delivery_state,
            mark_read,
            get_receipt_policy,
            set_receipt_policy,
            // §3.5 gap detection and repair
            list_gaps,
            request_gap_repair,
            // §3.7 local retention
            get_retention_policy,
            set_retention_policy,
            // §3.8 ephemeral hints
            send_ephemeral_hint,
            get_ephemeral_hint,
            // §3.9 purge requests
            send_purge_request,
            list_purge_requests,
            // §3.10 directory, safety numbers, self-audit and alarms
            resolve_handle,
            check_handle_eligibility,
            get_safety_number,
            set_verification,
            get_self_audit_state,
            list_alarms,
            acknowledge_alarm,
            // §3.11 relays and witnesses
            list_relays,
            add_relay,
            remove_relay,
            get_relay_capabilities,
            set_relay_trust,
            list_witnesses,
            set_witness_set,
            get_witness_set_state,
        }
    };
}
