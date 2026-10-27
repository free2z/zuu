from requests_oauthlib import OAuth1Session

from twatter.provider_deadline import (
    TwitterProviderDeadlineExceeded,
    twitter_provider_deadline,
)


TWITTER_OAUTH1_PROVIDER_TIMEOUT = (3.05, 8)

# Compatibility names for existing callers; the implementation is shared by
# OAuth 1 and OAuth 2 so both protocols get the same hard wall-clock bound.
TwitterOAuthProviderDeadlineExceeded = TwitterProviderDeadlineExceeded
twitter_oauth1_provider_deadline = twitter_provider_deadline


class TwitterOAuthClient:
    def __init__(self, consumer_key, consumer_secret):
        self.consumer_key = consumer_key
        self.consumer_secret = consumer_secret
        # We don't need access token to get request token?
        # self.get_access_token()
        #
        # self.access_token = access_token
        # self.access_token_secret = access_token_secret

    def get_request_token(self, callback_url):
        oauth_session = OAuth1Session(
            self.consumer_key,
            client_secret=self.consumer_secret,
            callback_uri=callback_url
        )
        with twitter_oauth1_provider_deadline():
            response = oauth_session.fetch_request_token(
                'https://api.twitter.com/oauth/request_token',
                timeout=TWITTER_OAUTH1_PROVIDER_TIMEOUT,
            )
        return response
