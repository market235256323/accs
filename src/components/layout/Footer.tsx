import Link from "next/link";

export default function Footer() {
  return (
    <footer className="bg-gray-900 text-white py-3 px-4 fixed bottom-0 left-0 right-0 w-full z-10 text-sm">
      <div className="w-full flex flex-col md:flex-row justify-between items-center">
        <div className="mb-2 md:mb-0">
          <div className="text-xs">MateSwap LP</div>
          <div className="text-xs text-gray-400">Address: 85 First Floor Great Portland Street, London, England, W1W 7LT</div>
        </div>
        <div className="flex space-x-4">
          <Link href="/terms" className="text-xs hover:text-gray-300 transition-colors">
            Terms of Service
          </Link>
          <Link href="/privacy" className="text-xs hover:text-gray-300 transition-colors">
            Privacy Policy
          </Link>
        </div>
      </div>
    </footer>
  );
}
