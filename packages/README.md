# Shared packages

This directory is intentionally empty until two migrated applications need shared code in the
same toolchain. Likely examples are a generated TypeScript API client and shared UI tokens
for Expo and React. Cross-language behavior belongs in `contracts`, not in a package imported
from the API.
