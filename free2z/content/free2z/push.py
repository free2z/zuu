"""
This is an initial spin of the https://free2z.cash/api/
with a hand-written Python client using requests.

This script will push creator and zpage data to free2z.cash.

In the future maybe this evolves into a real CLI,
maybe even one written in Rust.
"""
import os
import yaml
import difflib

import requests
from requests.auth import HTTPBasicAuth

# ROOT = os.environ.get("F2Z_URL", "http://127.0.0.1:8000")
ROOT = os.environ.get("F2Z_URL", "https://free2z.cash")

# TOKEN_LOGIN = f"{ROOT}/api/token/login/"
ZPAGE_CREATE = f"{ROOT}/api/zpage/"
ZPAGE_URL = lambda id: f"{ROOT}/api/zpage/{id}/"
CREATOR_UPDATE = f"{ROOT}/api/auth/user/"

PASSWORD = os.environ.get("F2Z_PASSWORD")
CONFIG_PATH = os.environ.get("F2Z_CONFIG_PATH", 'f2z.yaml')


if not PASSWORD:
    raise Exception("Must supply F2Z_PASSWORD in environment")


if __name__ == "__main__":

    with open(CONFIG_PATH) as f:
        config = yaml.safe_load(f)
        username = config['creator']['username']
        basic = HTTPBasicAuth(username, PASSWORD)

        # Update CREATOR
        # https://free2z.com/api/schema/redoc/#tag/auth/operation/auth_user_update
        requests.put(
            CREATOR_UPDATE,
            auth=basic,
            data=config['creator'],
        )

        zpages = config['zpages']
        for i, zp in enumerate(zpages):
            # Create and save an "id" for ever
            free2zaddr = zp.get('free2zaddr')
            if not free2zaddr:
                cres = requests.post(ZPAGE_CREATE, auth=basic).json()
                zpages[i] = cres
                free2zaddr = cres['free2zaddr']

            # Only push if changed
            with open(zp['path']) as contentfile:
                # normalized to unix file endings which is cool
                # how did CRLF get in there anyways?
                diskcontent = contentfile.read()

            zpres = requests.get(ZPAGE_URL(free2zaddr), auth=basic).json()
            # print('zpres', zpres)
            # print('zp', zp)

            # TODO: check other attrs as well ..
            # we don't want to bump the updated timestamp
            # if nothing is actually changing ...
            if zpres['content'] != diskcontent:
                print("UPDATE", zp['title'])
                # print(repr(diskcontent[:50]))
                # print(repr(zpres['content'][:50]))
                # # output_list = [
                # #     li for li in
                # #     difflib.ndiff(diskcontent, zpres['content'])
                # #     if li[0] != ' '
                # # ]
                # # print(output_list)
                # exit(0)
                zp['content'] = diskcontent
                requests.put(
                    ZPAGE_URL(free2zaddr),
                    data=zp,
                    auth=basic,
                )

            else:
                print("NO UPDATE", free2zaddr)

            # Don't write the page content to the yaml config
            zp.pop('content', None)

        with open('f2z.yaml', 'w') as wf:
            yaml.dump(config, wf)
