# Free2Z backend

Make sure you have followed the [python setup instructions](../../README.md)
to setup your local python environment.

You can use sqlite to develop locally:

```sh
./manage.py migrate
```

Create a superuser:

```sh
./manage.py createsuperuser
```

In local dev, without the RECAPTCHA secret setup,
you can go to http://localhost:8000/adminzzz/ to login
and then you should be logged in to the frontend on
http://locahost:3000/profile.
