# RTMP Setup

This project is an experiment into streaming video.
This document may help you follow along and reproduce the results.


We have a PC with Ubuntu (the Local Machine).
We'll be controlling the streaming server (Remote Machine)
and it's configuration via SSH with Ansible from the Local Machine.
We will stream from OBS on the Local Machine to NGINX on the
Remote Machine which will broadcast to arbitrary clients.


## Remote Machine

The remote machine is Debian (11, Bullseye) or possibly Ubuntu.
One vCPU Core with 4 GB of RAM should be enough to run an experiment.

> TODO: benchmark the performance we get

Once the machine is ready, add your SSH public key to the
`.ssh/authorized_keys` files so that you can SSH in with a
user who has `sudo`.

The rest of the remote machine setup will be done via this SSH
connection with Ansible.
Setting up SSH on a server is not covered here but there
are many decent guides on the internet.
https://docs.digitalocean.com/products/droplets/how-to/add-ssh-keys/


## Ubuntu Local Machine Setup

### Ansible

Following https://linuxhint.com/create-ansible-playbook-ubuntu/

```bash
sudo apt install software-properties-common
sudo add-apt-repository --yes --update ppa:ansible/ansible
sudo apt install ansible
vim /etc/ansible/hosts 
which ansible
ls
vim ~/ansible/hosts
mkdir ~/ansible
vim ~/ansible/hosts
```

Once you have ansible installed and an inventory setup,
you can run the playbook:

```
ansible-playbook -i ~/ansible/hosts
```
