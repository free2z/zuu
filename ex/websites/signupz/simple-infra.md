## Simple Deployment

This is a simple way to deploy using sqlite3.
Suitable for a small site only seeking a few dozen contacts.

Adapted from

https://www.digitalocean.com/community/tutorials/how-to-set-up-django-with-postgres-nginx-and-gunicorn-on-ubuntu-22-04

Create a VM:

```bash
gcloud compute instances create be-bg --project=free2z --zone=us-west1-b --machine-type=e2-medium --network-interface=network-tier=PREMIUM,subnet=default --maintenance-policy=MIGRATE --provisioning-model=STANDARD --service-account=314040764613-compute@developer.gserviceaccount.com --scopes=https://www.googleapis.com/auth/devstorage.read_only,https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write,https://www.googleapis.com/auth/servicecontrol,https://www.googleapis.com/auth/service.management.readonly,https://www.googleapis.com/auth/trace.append --tags=http-server,https-server --create-disk=auto-delete=yes,boot=yes,device-name=be-bg,image=projects/debian-cloud/global/images/debian-11-bullseye-v20220822,mode=rw,size=10,type=projects/free2z/zones/us-central1-a/diskTypes/pd-balanced --no-shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring --reservation-affinity=any
```

SSH to the VM

```
gcloud compute ssh --zone "us-west1-b" "be-bg"  --project "free2z"
```

```bash
sudo apt update
# sudo apt install python3-venv python3-dev libpq-dev postgresql postgresql-contrib nginx curl
sudo apt install python3-venv python3-dev nginx curl
sudo apt install git
git clone https://github.com/free2z/zuu
cd zuu/ex/websites/signupz
python3 -m venv env
source env/bin/activate
pip install -r requirements.txt
pip install gunicorn
./manage.py makemigrations
./manage.py migrate
./manage.py createsuperuser
sudo chown skyl:skyl /var/www/
./manage.py collectstatic
```

Gunicorn, Nginx

```bash
sudo vim /etc/systemd/system/gunicorn.socket
sudo vim /etc/systemd/system/gunicorn.service
sudo systemctl start gunicorn.socket
sudo systemctl enable gunicorn.socket
# ls /run/gunicorn.sock
sudo journalctl -u gunicorn.socket
sudo systemctl status gunicorn
curl --unix-socket /run/gunicorn.sock localhost
sudo systemctl status gunicorn
sudo vim /etc/nginx/sites-available/signupz
# ls /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/signupz /etc/nginx/sites-enabled
sudo nginx -t
sudo systemctl restart nginx
```