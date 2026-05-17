import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="min-h-dvh grid place-items-center px-4 py-12 bg-concierge-radial">
      <SignUp />
    </div>
  );
}
