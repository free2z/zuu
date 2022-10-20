I like files and directories and version control more
than I like fancy graphical user interfaces.
If I'm going to write something serious,
whether I want to publish it on free2z, substack
or some other web service, or if I want to make a
PDF, I want to save the canonical working copy as a file
on my computer. This file is such a file.
I'm saving it in version control in
[the free2z ZUU](https://github.com/free2z/zuu).
But, I want changes to also show up at
[https://free2z.cash/using-free2z-api-with-python-requests](https://free2z.cash/using-free2z-api-with-python-requests).
I'm not the type to copy-paste text around and try to keep versions
in sync manually. I automate things. So, I decided to use the
free2z API to update content on free2z that lives in my git repo.
This will make for a more scalable way for me to manage content
on free2z.

This is a proof-of-concept that will likely evolve into a
supported CLI interface to free2z.

## f2z.yaml

First, I don't want to pollute my markdown with frontmatter like
some systems do. I want the content to be in pure markdown.
Therefore, I'm going to create a little
[yaml](https://yaml.org/)
file for the metadata.


```yaml
creator:
  p2paddr: zs1fhtyukrdml9ez256gt0dz8h5xvljg57k9p8kwrxlpnk7f5w00rr35drqzgd5k4pajz4pu8p962d
  updateAll: true
  username: free2z
zpages:
- category: FREE2Z
  path: ./with-python-requests.md
  title: Using the free2z API with Python Requests
  vanity: using-free2z-api-with-python-requests
```

<!--   id: 2d15b574-17bc-468f-b688-b9674a8313ec -->

This defines the `creator` username as `free2z`
(the name you log in with)
and defines a creator-level `p2paddr` (peer-to-peer zaddress)
to use for all pages (which don't have an override `p2paddr`).
The "updateALL" is a special parameter which dictates whether
all zpages should use the creator `p2paddr`.

Next, there is a list of `zpages` with metadata such as `vanity`, `category`,
and `title`. The `path` specifies where the `content` lives
on the filesystem. In this case, I'm going to write in a file
named `with-python-requests.md` in the same directory as the `f2z.yaml` file.

The options for the creator are defined
[here](https://free2z.com/api/schema/redoc/#tag/auth/operation/auth_user_update).
The options for the zpage are defined
[here](https://free2z.com/api/schema/redoc/#tag/zpage/operation/zpage_update).

## f2z.py

We can write a tiny custom, purpose-built script to push our files to
free2z. Someday this may grow into a CLI with simple commands like
`f2z sync` to sync a directory to [free2z.com](https://free2z.com).

```python
"""
This is an initial spin of the https://free2z.cash/api/
with a hand-written Python client using requests.

In the future maybe this evolves into a real CLI,
maybe even one written in Rust.
"""
import os
import yaml

import requests
from requests.auth import HTTPBasicAuth

# ROOT = os.environ.get("F2Z_URL", "http://127.0.0.1:8000")
ROOT = os.environ.get("F2Z_URL", "https://free2z.cash")

TOKEN_LOGIN = f"{ROOT}/api/token/login/"
ZPAGE_CREATE = f"{ROOT}/api/zpage/"
ZPAGE_UPDATE = lambda id: f"{ROOT}/api/zpage/{id}/"
CREATOR_UPDATE = f"{ROOT}/api/auth/user/"

password = os.environ.get("F2Z_PASSWORD")
token = os.environ.get("F2Z_TOKEN")

if not (token or password):
    raise Exception("Must supply F2Z_PASSWORD or F2Z_TOKEN")


if __name__ == "__main__":
    # config = yaml.load("f2z.yaml")
    # print(config)

    with open('f2z.yaml') as f:
        config = yaml.safe_load(f)
        print(config)
        username = config['creator']['username']
        print(username)

        if not token:
            basic = HTTPBasicAuth(username, password)
            tokenres = requests.post(TOKEN_LOGIN, auth=basic)
            token = tokenres.json()['token']
            print("NEW TOKEN")
            print(token)

        headers = {
            "Authorization": f"Token {token}",
        }

        # Update CREATOR
        # https://free2z.com/api/schema/redoc/#tag/auth/operation/auth_user_update
        creatorupdatesres = requests.put(
            CREATOR_UPDATE, headers=headers, data=config['creator'])
        print("UPDATED CREATOR")
        print(creatorupdatesres)

        zpages = config['zpages']
        for i, zp in enumerate(zpages):
            # Create and save an "id" for every zpage
            if not zp.get('id'):
                cres = requests.post(ZPAGE_CREATE, headers=headers)
                newid = cres.json()['free2zaddr']
                print("NEWID", newid)
                zp['id'] = newid
                zpages[i] = zp
                # write+
                # yaml.dump(config, f)
                print()
            print('zp')
            print(zp)
            with open(zp['path']) as contentfile:
                zp['content'] = contentfile.read()
                print('CONTENT', zp)
            upres = requests.put(
                ZPAGE_UPDATE(zp['id']), data=zp, headers=headers)
            print('UPDATE RESPONSE', upres)

            # Don't write the page content to the yaml config
            zp.pop('content')

        with open('f2z.yaml', 'w') as wf:
            yaml.dump(config, wf)
```
