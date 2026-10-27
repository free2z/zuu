from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.management.base import BaseCommand

from dj.apps.uploads.models import EXIF_TYPES, GenericFile, IMAGE_MIME_TYPES, remove_exif_data


class Command(BaseCommand):
    help = 'Removes EXIF data from all image files'

    def handle(self, *args, **options):
        self.stdout.write('Starting EXIF data removal process...')
        image_files = GenericFile.objects.filter(
            mime_type__in=EXIF_TYPES,
            # owner__username="skylar"
        )
        count = image_files.count()
        processed = 0

        # print(image_files.count())
        for file_obj in image_files:
            processed += 1
            self.stdout.write(f'Processing file: {file_obj.file.name}')

            try:
                original_file = file_obj.file
                altered_image = remove_exif_data(original_file)

                if altered_image:
                    # Get the relative path of the file in the storage
                    file_rel_path = file_obj.file.name
                    # print(file_rel_path)

                    # # Write directly to the storage, overwriting the existing file
                    if default_storage.exists(file_rel_path):
                        default_storage.delete(file_rel_path)
                    default_storage.save(file_rel_path, ContentFile(altered_image.read()))

                    self.stdout.write(f'Successfully updated file: {file_obj.file.name}')
                    # break

            except Exception as e:
                self.stderr.write(f'Error processing file {file_obj.file.name}: {e}')
            print(f'{processed} / {count}')
        self.stdout.write('EXIF data removal process completed.')
