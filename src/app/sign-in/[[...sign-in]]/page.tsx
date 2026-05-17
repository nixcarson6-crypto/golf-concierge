import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="min-h-dvh grid place-items-center px-4 py-12 bg-concierge-radial">
      <SignIn />
    </div>
  );
}
