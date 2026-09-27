# dj.proj.free2z

Parts of the Free2Z backend are open-sourced here.

Prerequisites:

- Historical Python baseline: >= 3.12; this move does not revalidate runtime support.
- The historical `py/requirements/main.txt` dependency manifest is absent from
  this public scaffold. Dependency restoration and runtime validation are still
  required; the commands below describe the expected layout, not a currently
  supported standalone installation.

## Historical setup (after dependencies are restored)

Once the missing manifest and dependencies have been restored, start in the
`py/free2z/` directory and create a virtual environment:

```bash
python -m venv env
source env/bin/activate
pip install -r ../requirements/main.txt
export PYTHONPATH=`pwd`
```

The scaffold's development-server entrypoint is:

```bash
cd dj/proj/free2z
./manage.py runserver
```

You can also run the frontend, see [ts/react/free2z](../../../../../ts/react/free2z/README.md).
Change the proxy in `ts/react/free2z/package.json` to `http://localhost:8000`.

## Features so far open-sourced

- p2pe2ee messaging prototype: https://localhost:3000/tools/p2pe2e

## Contributing

Check out the issues for ideas: https://github.com/free2z/zuu/issues

Feel free to make your own issues and submit your own pull request ideas!

Let us know if you would like to see more of the backend open-sourced!
