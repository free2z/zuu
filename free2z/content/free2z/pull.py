"""
This is an initial spin of the https://free2z.cash/api/
with a hand-written Python client using requests.

This script will pull creator data and zpage data from free2z.cash.

In the future maybe this evolves into a real CLI,
maybe even one written in Rust.
"""
import os
import yaml

import requests
from requests.auth import HTTPBasicAuth

ROOT = os.environ.get("F2Z_URL", "https://free2z.cash")
# TOKEN_LOGIN = f"{ROOT}/api/token/login/"
ZPAGES_URL = f"{ROOT}/api/zpage/"
ZPAGE_URL = lambda id: f"{ROOT}/api/zpage/{id}/"
CREATOR_URL = f"{ROOT}/api/auth/user/"

PASSWORD = os.environ.get("F2Z_PASSWORD")
CONFIG_PATH = os.environ.get("F2Z_CONFIG_PATH", 'f2z.yaml')

READONLY_FIELDS = [
    'created_at', 'updated_at',
    'f2z_score', 'is_funded', 'is_verified', 'total',
]


if not PASSWORD:
    raise Exception("Must supply F2Z_PASSWORD in environment")


if __name__ == "__main__":

    with open(CONFIG_PATH) as f:
        config = yaml.safe_load(f)
        username = config['creator']['username']
        basic = HTTPBasicAuth(username, PASSWORD)

        cres = requests.get(CREATOR_URL, auth=basic)
        creator = cres.json()
        # TODO: distinguish between read/write attributes
        creator.pop('is_verified')
        creator.pop('total')
        creator.pop('zpages')
        #
        config['creator'] = creator

        # paginate through zpages and write files
        pres = requests.get(f"{ZPAGES_URL}?mine=1", auth=basic).json()
        nexturl = pres['next']
        zpages: list = pres['results']

        while nexturl:
            pres = requests.get(nexturl, auth=basic).json()
            nexturl = pres['next']
            zpages.extend(pres['results'])

        # Remove readonly fields from what is persisted
        # TODO: automatic maintenance? more elegant?
        [zp.pop(f) for f in READONLY_FIELDS for zp in zpages]
        print(len(zpages))

        pops = []
        for i, zp in enumerate(zpages):
            if not zp['vanity']:
                pops.append(i)
                continue
            zpres = requests.get(ZPAGE_URL(zp['free2zaddr']), auth=basic)

            path = f"{zp['vanity']}.md"
            zp['path'] = path
            with open(path, 'w') as zpcf:
                zpcf.write(zpres.json()['content'])

        # remove zpages without a vanity hrm ...
        [zpages.pop(i) for i in pops]
        config['zpages'] = zpages

    with open(CONFIG_PATH, 'w') as wf:
        yaml.dump(config, wf)
