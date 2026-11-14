from unittest.mock import Mock

import pytest

from dj.apps.dyte.client import DyteClient


def test_custom_host_id_is_resolved_before_provider_delete(mocker):
    listing = Mock(status_code=200)
    listing.json.return_value = {'success': True, 'data': [{
        'id': '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e',
        'custom_participant_id': 'host_0123456789abcdef',
    }]}
    kick = Mock(status_code=200, json=lambda: {'success': True, 'data': {}})
    deletion = Mock(status_code=200, json=lambda: {'success': True, 'data': {}})
    get = mocker.patch('dj.apps.dyte.client._SESSION.get', return_value=listing)
    post = mocker.patch('dj.apps.dyte.client._SESSION.post', return_value=kick)
    delete = mocker.patch(
        'dj.apps.dyte.client._SESSION.delete', return_value=deletion,
    )

    assert DyteClient().retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is True

    assert get.call_args.args[0].endswith(
        '/meetings/meeting-uuid/participants',
    )
    assert post.call_args.args[0].endswith(
        '/meetings/meeting-uuid/active-session/kick',
    )
    assert post.call_args.kwargs['json'] == {
        'participant_ids': ['182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e'],
    }
    assert delete.call_args.args[0].endswith(
        '/meetings/meeting-uuid/participants/'
        '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e',
    )


def test_all_matching_custom_ids_across_pages_are_retired(mocker):
    custom_id = 'host_0123456789abcdef'
    first_page = Mock(status_code=200)
    first_page.json.return_value = {'success': True, 'data': [
        {'id': 'provider-first', 'custom_participant_id': custom_id},
        *[{'id': f'other-{i}', 'custom_participant_id': 'someone-else'}
          for i in range(99)],
    ]}
    second_page = Mock(status_code=200)
    second_page.json.return_value = {'success': True, 'data': [
        {'id': 'provider-second', 'custom_participant_id': custom_id},
    ]}
    get = mocker.patch('dj.apps.dyte.client._SESSION.get',
                       side_effect=[first_page, second_page])
    post = mocker.patch('dj.apps.dyte.client._SESSION.post',
                        return_value=Mock(status_code=200, json=lambda: {'success': True, 'data': {}}))
    delete = mocker.patch('dj.apps.dyte.client._SESSION.delete',
                          return_value=Mock(status_code=200, json=lambda: {'success': True, 'data': {}}))

    assert DyteClient().retire_participant('meeting', custom_id) is True

    assert get.call_count == 2
    assert [call.kwargs['json'] for call in post.call_args_list] == [
        {'participant_ids': ['provider-first']},
        {'participant_ids': ['provider-second']},
    ]
    assert [call.args[0].rsplit('/', 1)[-1]
            for call in delete.call_args_list] == [
        'provider-first', 'provider-second',
    ]


def test_partial_duplicate_retirement_failure_is_not_success(mocker):
    custom_id = 'host_0123456789abcdef'
    listing = Mock(status_code=200)
    listing.json.return_value = {'success': True, 'data': [
        {'id': 'provider-first', 'custom_participant_id': custom_id},
        *[{'id': f'other-{i}', 'custom_participant_id': 'someone-else'}
          for i in range(98)],
        {'id': 'provider-second', 'custom_participant_id': custom_id},
    ]}
    final_page = Mock(status_code=200)
    final_page.json.return_value = {'success': True, 'data': []}
    get = mocker.patch('dj.apps.dyte.client._SESSION.get',
                       side_effect=[listing, final_page])
    mocker.patch('dj.apps.dyte.client._SESSION.post',
                 return_value=Mock(status_code=200, json=lambda: {'success': True, 'data': {}}))
    delete = mocker.patch(
        'dj.apps.dyte.client._SESSION.delete',
        side_effect=[Mock(status_code=200, json=lambda: {'success': True, 'data': {}}), Mock(status_code=503)],
    )

    assert DyteClient().retire_participant('meeting', custom_id) is False

    assert get.call_count == 2  # all matches were resolved before deletion
    assert delete.call_count == 2


def test_empty_lookup_remains_pending_until_a_late_mint_can_be_retired(
    mocker,
):
    listing = Mock(status_code=200)
    listing.json.return_value = {'success': True, 'data': []}
    late_listing = Mock(status_code=200)
    late_listing.json.return_value = {'success': True, 'data': [{
        'id': 'provider-participant-id',
        'custom_participant_id': 'host_0123456789abcdef',
    }]}
    get = mocker.patch('dj.apps.dyte.client._SESSION.get',
                       side_effect=[listing, late_listing])
    post = mocker.patch(
        'dj.apps.dyte.client._SESSION.post',
        return_value=Mock(status_code=200, json=lambda: {'success': True, 'data': {}}),
    )
    delete = mocker.patch(
        'dj.apps.dyte.client._SESSION.delete',
        return_value=Mock(status_code=200, json=lambda: {'success': True, 'data': {}}),
    )

    client = DyteClient()
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
        'dj.apps.dyte.client._SESSION.get',
        return_value=Mock(status_code=status_code),
    )
    post = mocker.patch('dj.apps.dyte.client._SESSION.post')
    delete = mocker.patch('dj.apps.dyte.client._SESSION.delete')

    assert DyteClient().retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is False

    get.assert_called_once()
    post.assert_not_called()
    delete.assert_not_called()


@pytest.mark.parametrize('payload', [
    None, [], {}, {'success': True, 'data': None}, {'success': True, 'data': 'not-a-list'},
    {'success': True, 'data': [None]}, {'success': True, 'data': ['not-an-object']},
    {'success': True, 'data': [{'id': 'provider-id'}]},
    {'success': True, 'data': [{'custom_participant_id': 'someone-else'}]},
    {'success': True, 'data': [{'id': 'provider-id', 'custom_participant_id': 123}]},
])
def test_invalid_participant_list_payload_is_retryable(mocker, payload):
    listing = Mock(status_code=200)
    if payload is None:
        listing.json.side_effect = ValueError('not JSON')
    else:
        listing.json.return_value = payload
    mocker.patch('dj.apps.dyte.client._SESSION.get', return_value=listing)
    post = mocker.patch('dj.apps.dyte.client._SESSION.post')
    delete = mocker.patch('dj.apps.dyte.client._SESSION.delete')

    assert DyteClient().retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is False

    post.assert_not_called()
    delete.assert_not_called()


def test_participant_list_page_cap_is_retryable(mocker):
    listing = Mock(status_code=200)
    listing.json.return_value = {'success': True, 'data': [
        {'id': 'provider-match',
         'custom_participant_id': 'host_0123456789abcdef'},
        *[{'id': f'provider-{index}', 'custom_participant_id': 'someone-else'}
          for index in range(99)],
    ]}
    get = mocker.patch('dj.apps.dyte.client._SESSION.get',
                       return_value=listing)
    post = mocker.patch('dj.apps.dyte.client._SESSION.post')
    delete = mocker.patch('dj.apps.dyte.client._SESSION.delete')

    assert DyteClient().retire_participant(
        'meeting-uuid', 'host_0123456789abcdef',
    ) is False

    assert get.call_count == 20
    post.assert_not_called()
    delete.assert_not_called()


def test_page_error_after_a_match_is_retryable_without_partial_retirement(
    mocker,
):
    custom_id = 'host_0123456789abcdef'
    first_page = Mock(status_code=200)
    first_page.json.return_value = {'success': True, 'data': [
        {'id': 'provider-match', 'custom_participant_id': custom_id},
        *[{'id': f'provider-{index}', 'custom_participant_id': 'someone-else'}
          for index in range(99)],
    ]}
    failed_page = Mock(status_code=503)
    get = mocker.patch('dj.apps.dyte.client._SESSION.get',
                       side_effect=[first_page, failed_page])
    post = mocker.patch('dj.apps.dyte.client._SESSION.post')
    delete = mocker.patch('dj.apps.dyte.client._SESSION.delete')

    assert DyteClient().retire_participant('meeting', custom_id) is False

    assert get.call_count == 2
    post.assert_not_called()
    delete.assert_not_called()
