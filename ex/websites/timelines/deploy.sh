# as the appropriate user with the appropriate setup
# ::shruggie::
# TODO: ansible or k8s or sth ...
# git pull
source env/bin/activate
pushd dj
./manage.py migrate
sudo systemctl daemon-reload
sudo systemctl enable gunicorn.socket
sudo systemctl restart gunicorn.socket
sudo systemctl status gunicorn
