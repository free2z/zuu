from unittest.mock import Mock

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


def test_missing_custom_host_id_is_idempotently_cleaned_without_delete(mocker):
    listing = Mock(status_code=200)
    listing.json.return_value = {'data': []}
    get = mocker.patch('dj.apps.dyte.client.requests.get', return_value=listing)
    post = mocker.patch('dj.apps.dyte.client.requests.post')
    delete = mocker.patch('dj.apps.dyte.client.requests.delete')

    assert DyteClient('org').retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is True

    get.assert_called_once()
    post.assert_not_called()
    delete.assert_not_called()
