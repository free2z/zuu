from django.core.files.storage import Storage, storages


def get_export_storage() -> Storage:
    """Retrieve the private export archive storage backend.

    Uses the 'exports' alias from django settings.STORAGES.
    Archives are always stored in private temporary object storage,
    never mixed with GenericFile or the public media library.
    """
    return storages["exports"]
