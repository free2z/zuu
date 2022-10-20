I like files and directories and version control more
than I like fancy graphical user interfaces.
If I'm going to write something serious,
whether I want to publish it on free2z, substack
or some other web service, or if I want to make a
PDF, I want to save the canonical working copy as a file
on my computer. This file is such a file.
I'm saving it in version control in
[the free2z ZUU](https://github.com/free2z/zuu/blob/main/free2z/content/free2z/using-free2z-api-with-python-requests.md).
But, I want changes to also show up at
[https://free2z.cash/using-free2z-api-with-python-requests](https://free2z.cash/using-free2z-api-with-python-requests).
I'm not the type to copy-paste text around and try to keep versions
in sync manually. I automate things. So, I decided to use the
free2z API to update content on free2z that lives in my git repo.
This will make for a more scalable way for me to manage content
on free2z.

Since I'm interacting with the API, I decided to go for a full
two-way sync. This way I can change content on [free2z][https://free2z.cash]
and pull the changes into my version control. Or, I can change the
content in the repository and push the changes to free2z!

This is a proof-of-concept that will likely evolve into a
supported CLI interface to free2z.

## Prerequisites

With Python3 installed and a virtualenv created,
you can install the dependencies old-school style with pip:

```
pip install -r requirements.xt
```

For this experiment, it's basically `requests` and `pyyaml`.

## Pulling content from Free2z

This part might be interesting for a lot of people if managing
more than a few pages on free2z. This way you can back up your content
and take it elsewhere if you like.

Create a yaml file with your creator username.
Since my username is `free2z`, the file looks like this:

```yaml
creator:
  username: free2z
```

Put a file like this in a new, empty directory and name it `f2z.yaml`.

Add your password to your environment.

```bash
export F2Z_PASSWORD=my9@ssw0rd
```

Now you can run the `pull.py` script:

```py
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
```

This is a simple one-off script that:

1. Pulls creator details and adds metadata to `f2z.yaml`
2. Pulls zPage content and writes it to disk

Now your `f2z.yaml` should have a lot more content.
Mine now begins with:

```yaml
creator:
  email: skylar@free2z.com
  first_name: ''
  last_name: ''
  p2paddr: zs1fhtyukrdml9ez256gt0dz8h5xvljg57k9p8kwrxlpnk7f5w00rr35drqzgd5k4pajz4pu8p962d
  username: free2z
zpages:
- category: ZCASH
  free2zaddr: 720d73d0-35fd-4f16-a655-7b332ebee1b4
  is_published: true
  p2paddr: zs1fhtyukrdml9ez256gt0dz8h5xvljg57k9p8kwrxlpnk7f5w00rr35drqzgd5k4pajz4pu8p962d
  path: free2z-at-zcon3.md
  thumbnail_url: https://i.ytimg.com/vi/grF_ifpCiAQ/hqdefault.jpg?sqp=-oaymwEcCNACELwBSFXyq4qpAw4IARUAAIhCGAFwAcABBg==&rs=AOn4CLDt8jMERGbq2eBg6KyHSndeRxpx8g
  title: Free2z at ZCON3
  vanity: free2z-at-zcon3
```

The creator details and a list of zpage metadata are filled in now.

## Pushing content to free2z

Now that I have my content and metadata on disk (and in version control),
I want to create a new page and push the content to free2z.

### Create a new `zpages` entry in the `f2z.yaml`

To the list of zpages, I add to the front:

```yaml
- category: FREE2Z
  is_published: false
  path: using-free2z-api-with-python-requests.md
  title: Using the free2z API with Python Requests
  vanity: using-free2z-api-with-python-requests
```

Now I can write markdown content in the file
`using-free2z-api-with-python-requests.md` in the same directory.

When I'm reasonably happy with the content and want to see it on the
website, I invoke the following script (`push.py`):

```py
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
```

Because I don't have a `free2zaddr`, one will be created and saved.
After I run the script, the `f2z.yaml` zpages entry looks like this:

```yaml
- category: FREE2Z
  free2zaddr: edfb334f-a411-4194-83df-760b076d2860
  is_published: false
  p2paddr: zs1fhtyukrdml9ez256gt0dz8h5xvljg57k9p8kwrxlpnk7f5w00rr35drqzgd5k4pajz4pu8p962d
  path: using-free2z-api-with-python-requests.md
  thumbnail_url: ''
  title: Using the free2z API with Python Requests
  vanity: using-free2z-api-with-python-requests
```

It includes data I didn't add like `is_published`, `thumbnail_url`.
I can fill in that with `true` and a url to an image when ready.

Now I can edit all my content and sync it to free2z with a simple

```bash
python push.py
```

Try it out and tell me what you think!
We will probably use this as a basis for a more featureful CLI
in the future depending on experience and feedback.
