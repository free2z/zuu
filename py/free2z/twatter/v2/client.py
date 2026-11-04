import os
import base64
import json
import requests

from twatter.provider_deadline import twitter_provider_deadline

_HTTP_TIMEOUT_SECONDS = 15


def get_client(callback_url):
    return TwitterClient(
        os.environ["TWITTER_CLIENT_ID"],
        os.environ["TWITTER_CLIENT_SECRET"],
        callback_url)


class TwitterClient:
    def __init__(self, client_id, client_secret, callback_url):
        self.client_id = client_id
        self.client_secret = client_secret
        self.callback_url = callback_url
        self.access_token = None

    def exchange_code_for_token(self, code, code_verifier):
        auth = base64.b64encode(
            f'{self.client_id}:{self.client_secret}'.encode()
        ).decode()
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {auth}",
        }
        data = {
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": self.callback_url,
            "code_verifier": code_verifier
        }
        with twitter_provider_deadline():
            response = requests.post(
                "https://api.twitter.com/2/oauth2/token",
                headers=headers, data=data, timeout=_HTTP_TIMEOUT_SECONDS)

        if response.status_code != 200:
            raise Exception(response.text)

        # Parse the JSON response
        response_data = json.loads(response.text)

        # Extract the access token
        self.access_token = response_data.get("access_token")

    def get_me(self):
        """
        Get the current user
        """
        # https://developer.twitter.com/en/docs/twitter-api/users/lookup/api-reference/get-users-me
        headers = {
            "Authorization": f"Bearer {self.access_token}",
        }

        params = {
            'user.fields': 'id,username,name,profile_image_url,description'
        }

        with twitter_provider_deadline():
            response = requests.get(
                "https://api.twitter.com/2/users/me",
                headers=headers,
                params=params,
                timeout=_HTTP_TIMEOUT_SECONDS,
            )

        if response.status_code != 200:
            raise Exception(response.text)

        response_data = response.json()['data']
        # {'data': {'id': '1501132902201012229', 'name': 'F2z', 'username': 'F2ZP2P'}}
        return response_data
