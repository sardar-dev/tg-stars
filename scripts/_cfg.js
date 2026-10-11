// Scripts ke liye halki config: sirf wahi env vars maangta hai jo script ko chahiye.
export function loadConfigForProbe() {
  const need = (n) => {
    const v = process.env[n];
    if (!v) {
      console.error(`Missing env var ${n} (.env file mein daalo)`);
      process.exit(1);
    }
    return v;
  };
  return {
    digiseller: {
      sellerId: Number(need("DIGISELLER_SELLER_ID")),
      apiKey: need("DIGISELLER_API_KEY"),
      usernameOptionId: process.env.DIGISELLER_USERNAME_OPTION_ID ?? "",
      deliverUrlTemplate: "",
    },
  };
}
