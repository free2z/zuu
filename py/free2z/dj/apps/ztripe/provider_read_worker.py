"""Isolated read-only Stripe SDK worker; input/output are bounded JSON.

Run as a fresh interpreter, without importing Django or inheriting database
connections. The parent owns termination, including DNS and response parsing.
No exception text, credentials or provider response is emitted to stderr.
"""
import json
import logging
import sys

import stripe

MAX_INPUT_BYTES = 65536
MAX_OUTPUT_BYTES = 1024 * 1024
ALLOWED_READS = {
    ('events', 'retrieve'), ('charges', 'retrieve'), ('refunds', 'list'),
    ('balance_transactions', 'retrieve'), ('disputes', 'list'), ('disputes', 'retrieve'),
}


def read_provider(request):
    if (request['resource'], request['operation']) not in ALLOWED_READS:
        raise ValueError('unsupported read')
    transport = stripe.RequestsClient(timeout=request['timeout'])
    try:
        client = stripe.StripeClient(request['api_key'], stripe_version=request['api_version'],
            max_network_retries=0, http_client=transport)
        method = getattr(getattr(client.v1, request['resource']), request['operation'])
        value = method(*request['args'])
        return value.to_dict() if isinstance(value, stripe.StripeObject) else value
    finally:
        transport.close()


def main():
    logging.disable(logging.CRITICAL)
    try:
        payload = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(payload) > MAX_INPUT_BYTES:
            raise ValueError('request too large')
        value = read_provider(json.loads(payload))
        output = json.dumps({'status': 'ok', 'value': value}, separators=(',', ':')).encode('utf-8')
        if len(output) > MAX_OUTPUT_BYTES:
            raise ValueError('response too large')
    except Exception:
        output = b'{"status":"unavailable"}'
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
