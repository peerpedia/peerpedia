from django.apps import AppConfig


class PublishingConfig(AppConfig):
    name = "publishing"

    def ready(self):
        from django.urls import register_converter
        from django.urls.converters import get_converters
        from .identifiers import PaperCodeConverter

        # Register before URLs or API modules are imported in any order.
        if "paper_code" not in get_converters():
            register_converter(PaperCodeConverter, "paper_code")
