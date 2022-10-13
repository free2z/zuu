# zuul.free2z.cash/conf

Ansible playbook to put zcashd/lightwalletd on a single GCP VM.

## GCP setup

Setting up GCP to work with ansible is non-trivial.
There are a lot of options and dead-ends.

> TODO: detail setup with actual working snippets/files

`~/.ansible.cfg`

`~/ansible/inventory.gcp.yml`

`~/ansible/group_vars/all.yml`

For now:

(should have gone straight to k8s LOL!)

https://docs.ansible.com/ansible-core/2.13/user_guide/become.html#risks-of-becoming-an-unprivileged-user

https://docs.ansible.com/ansible/latest/user_guide/become.html

https://docs.ansible.com/ansible/latest/user_guide/connection_details.html

https://docs.ansible.com/ansible/latest/user_guide/intro_adhoc.html

https://stackoverflow.com/a/66012496/177293

https://docs.ansible.com/ansible/2.6/user_guide/intro_inventory.html

https://docs.ansible.com/ansible/2.4/intro_configuration.html#private-key-file

https://docs.ansible.com/ansible/latest/scenario_guides/guide_gce.html

https://blog.devgenius.io/gcp-vm-instances-provisioning-and-configuring-using-ansible-bb58e40f01cd

https://alex.dzyoba.com/blog/gcp-ansible-service-account/

https://www.bionconsulting.com/blog/gcp-iap-tunnelling-on-ansible-with-dynamic-inventory

https://binx.io/2021/03/10/how-to-tell-ansible-to-use-gcp-iap-tunneling/

