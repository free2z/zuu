from unittest.mock import Mock

import pytest

from dj.apps.dyte.client import DyteClient


def test_custom_host_id_is_resolved_before_provider_delete(mocker):
    listing = Mock(status_code=200)
    listing.json.return_value = {'data': [{
        'id': '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e',
        'custom_participant_id': 'host_0123456789abcdef',
    }]}
    kick = Mock(status_code=200)
    deletion = Mock(status_code=204)
    get = mocker.patch('dj.apps.dyte.client.requests.get', return_value=listing)
    post = mocker.patch('dj.apps.dyte.client.requests.post', return_value=kick)
    delete = mocker.patch(
        'dj.apps.dyte.client.requests.delete', return_value=deletion,
    )

    assert DyteClient('org').retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is True

    assert get.call_args.args[0].endswith(
        '/v2/meetings/meeting-uuid/participants',
    )
    assert post.call_args.args[0].endswith(
        '/v2/meetings/meeting-uuid/active-session/kick',
    )
    assert post.call_args.kwargs['json'] == {
        'participant_ids': ['182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e'],
    }
    assert delete.call_args.args[0].endswith(
        '/v2/meetings/meeting-uuid/participants/'
        '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e',
    )


def test_empty_lookup_remains_pending_until_a_late_mint_can_be_retired(
    mocker,
):
    listing = Mock(status_code=200)
    listing.json.return_value = {'data': []}
    late_listing = Mock(status_code=200)
    late_listing.json.return_value = {'data': [{
        'id': 'provider-participant-id',
        'custom_participant_id': 'host_0123456789abcdef',
    }]}
    get = mocker.patch('dj.apps.dyte.client.requests.get',
                       side_effect=[listing, late_listing])
    post = mocker.patch(
        'dj.apps.dyte.client.requests.post',
        return_value=Mock(status_code=200),
    )
    delete = mocker.patch(
        'dj.apps.dyte.client.requests.delete',
        return_value=Mock(status_code=204),
    )

    client = DyteClient('org')
    assert client.retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is False
    post.assert_not_called()
    delete.assert_not_called()

    assert client.retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is True

    assert get.call_count == 2
    post.assert_called_once()
    delete.assert_called_once()


@pytest.mark.parametrize('status_code', [401, 429, 500, 503])
def test_participant_list_http_errors_are_retryable(mocker, status_code):
    get = mocker.patch(
        'dj.apps.dyte.client.requests.get',
        return_value=Mock(status_code=status_code),
    )
    post = mocker.patch('dj.apps.dyte.client.requests.post')
    delete = mocker.patch('dj.apps.dyte.client.requests.delete')

    assert DyteClient('org').retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is False

    get.assert_called_once()
    post.assert_not_called()
    delete.assert_not_called()


@pytest.mark.parametrize('payload', [
    None, [], {}, {'data': None}, {'data': 'not-a-list'},
    {'data': [None]}, {'data': ['not-an-object']},
    {'data': [{'id': 'provider-id'}]},
    {'data': [{'custom_participant_id': 'someone-else'}]},
    {'data': [{'id': 'provider-id', 'custom_participant_id': 123}]},
])
def test_invalid_participant_list_payload_is_retryable(mocker, payload):
    listing = Mock(status_code=200)
    if payload is None:
        listing.json.side_effect = ValueError('not JSON')
    else:
        listing.json.return_value = payload
    mocker.patch('dj.apps.dyte.client.requests.get', return_value=listing)
    post = mocker.patch('dj.apps.dyte.client.requests.post')
    delete = mocker.patch('dj.apps.dyte.client.requests.delete')

    assert DyteClient('org').retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is False

    post.assert_not_called()
    delete.assert_not_called()


def test_participant_list_page_cap_is_retryable(mocker):
    listing = Mock(status_code=200)
    listing.json.return_value = {'data': [
        {'id': f'provider-{index}', 'custom_participant_id': 'someone-else'}
        for index in range(100)
    ]}
    get = mocker.patch('dj.apps.dyte.client.requests.get',
                       return_value=listing)
    post = mocker.patch('dj.apps.dyte.client.requests.post')
    delete = mocker.patch('dj.apps.dyte.client.requests.delete')

    assert DyteClient('org').retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is False

    assert get.call_count == 20
    post.assert_not_called()
    delete.assert_not_called()
