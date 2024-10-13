# dj.proj.zuu

Parts of the Free2Z backend are open-sourced here.

Prerequisites:

- Tested against Python >= 3.12
- [Requirements](../../../requirements/main.txt)

## Quickstart

Assuming you are in the `py/` directory with a recent version of Python
installed, you can create a virtual environment and install the requirements:

```bash
python -m venv env
source env/bin/activate
pip install -r requirements/main.txt
export PYTHONPATH=`pwd`
```

Then you can run the Django development server:

```bash
cd dj/proj/zuu
./manage.py runserver
```

You can also run the frontend, see [ts/react/free2z](../../../../ts/react/free2z/README.md).
Change the proxy in `ts/react/free2z/package.json` to `http://localhost:8000`.

## Features so far open-sourced

- p2pe2ee messaging prototype: https://localhost:3000/tools/p2pe2e

## Contributing

Check out the issues for ideas: https://github.com/free2z/zuu/issues

Feel free to make your own issues and submit your own pull request ideas!

Let us know if you would like to see more of the backend open-sourced!
