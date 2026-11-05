"""Tri-state forced function choice (zuu#1144).

Existing rows retain NULL/omission: no signing-body, version or ETag change.
New rows default false (including DB inserts); no provider support is guessed.
Deploy gateway enforcement before publishing explicit denials: old schema-1
readers verify the raw tree but ignore unknown members. Keep unsupported models
out of tool-enabled catalogues until enforcing gateways are deployed.
"""
from django.db import migrations, models

HELP = ("Signed forced_tool_choice policy: true permits required/named function choice, "
        "false refuses it before a hold. NULL preserves legacy admission and is omitted from "
        "the signed body. New rows default to false; enable only after reviewed evidence.")


class Migration(migrations.Migration):
    dependencies = [("openai", "0032_tools_require_effort_none")]
    operations = [
        migrations.AddField(
            model_name="aimodel", name="supports_forced_tool_choice",
            field=models.BooleanField(null=True, default=None, help_text=HELP),
        ),
        migrations.AlterField(
            model_name="aimodel", name="supports_forced_tool_choice",
            field=models.BooleanField(null=True, default=False, db_default=False, help_text=HELP),
        ),
    ]
