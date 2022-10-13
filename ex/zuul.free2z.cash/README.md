# zuul.free2z.cash

Running a lightwalletd server on GCP infra.

Simple VM setup, adding simple ansible.

> TODO: postgres and decent scale. k8s?

## Prereqs

You should have Ansible installed on your host machine.
If you have python3 and virtualenv installed,
you may run in this directory:

```bash
virtualenv env -p `which python3`
source env/bin/activate
pip install -r requirements.txt
```

Now you should have ansible, `ansible-playbook` and other commands.
