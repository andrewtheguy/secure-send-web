no backward compatibility

always use extractable: false for Web Crypto API keys even for asymmetric keys because public keys can always be exported

Always run npm run lint and then npx tsc -b to check and fix any issues before committing code