'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth/AuthProvider';
import Footer from '@/components/layout/Footer';
import UserMenu from '@/components/auth/UserMenu';
import { collection, query, where, getDocs, orderBy, doc, getDoc } from 'firebase/firestore';
import { db } from '@/firebase/config';
import { Chat } from '@/types/chat';

// Extended Chat interface with transaction display properties
interface ChatWithTransactionData extends Chat {
  amount: number;
  otherParty: string;
  subscribers: number;
  status: string;
  type: string; 
  userIcon?: string;
  creationDate?: Date;
}

// Filter options
const networkOptions = ['All Networks', 'YouTube', 'Instagram', 'TikTok', 'Twitter', 'Facebook'];
const typeOptions = ['All Types', 'Purchase', 'Sale'];
const statusOptions = ['All Status', 'Active', 'Inactive', 'Completed', 'Cancelled'];

export default function TransactionsDashboard() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [chats, setChats] = useState<ChatWithTransactionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const itemsPerPage = 20; // 20 ტრანზაქცია ერთ გვერდზე
  const [filters, setFilters] = useState({
    network: 'All Networks',
    type: 'All Types',
    status: 'All Status',
    minAmount: '',
    maxAmount: ''
  });

  useEffect(() => {
    // Wait until auth is no longer loading before redirecting
    if (authLoading) {
      // Still checking auth status, don't do anything yet
      return;
    }
    
    // Only redirect if auth is done loading AND user is null
    if (!authLoading && !user) {
      router.push('/login');
      return;
    }
    
    // If we have a user, fetch chats
    if (user) {
      const fetchChats = async () => {
        try {
          setLoading(true);
          
          // Get user's chat list
          const userChatListRef = collection(db, `users/${user.id}/chatList`);
          const chatListSnapshot = await getDocs(userChatListRef);
          
          if (chatListSnapshot.empty) {
            setChats([]);
            setTotalPages(0);
            setLoading(false);
            return;
          }
          
          // Get chat IDs from the user's chat list
          const chatPromises = chatListSnapshot.docs.map(async (docSnapshot) => {
            const chatData = docSnapshot.data();
            const chatId = docSnapshot.id;
            
            // Get full chat data from the main chats collection
            const chatDoc = await getDoc(doc(db, "chats", chatId));
            if (chatDoc.exists()) {
              const chatDocData = chatDoc.data() as Chat;
              
              // Calculate the number of subscribers (participants)
              let subscriberCount = 0;
              if (chatDocData.participants) {
                subscriberCount = chatDocData.participants.length;
              } else if (chatDocData.participantPhotos) {
                subscriberCount = Object.keys(chatDocData.participantPhotos).length;
              }
              
              // Determine transaction type (Purchase/Sale)
              const transactionType = user.id === chatDocData.sellerId ? 'Sale' : 'Purchase';
              
              // Get the product amount
              const productAmount = chatDocData.productPrice || chatDocData.totalAmount || 0;
              
              // Determine the other party
              let otherPartyName = '';
              if (transactionType === 'Sale') {
                // If user is seller, get buyer name
                otherPartyName = chatDocData.participantNames?.[chatDocData.buyerId || ''] || 'Buyer';
              } else {
                // If user is buyer, get seller name
                otherPartyName = chatDocData.participantNames?.[chatDocData.sellerId || ''] || 'Seller';
              }
              
              // Create creation date from timestamp
              const creationDate = chatDocData.createdAt 
                ? new Date(typeof chatDocData.createdAt === 'number' ? chatDocData.createdAt : Date.now())
                : new Date();
              
              // Determine transaction status
              const transactionStatus = chatDocData.status || 
                (chatDocData.paymentStatus === 'completed' ? 'Completed' : 'Active');
                
              // Get other party's profile photo
              const otherPartyIcon = transactionType === 'Sale'
                ? chatDocData.participantPhotos?.[chatDocData.buyerId || ''] || '/agent.png' 
                : chatDocData.participantPhotos?.[chatDocData.sellerId || ''] || '/agent.png';

              // Get product subscribers count (if available)
              let subscribersCount = 0;
              
              // If chat has a productId, fetch the product details to get subscribers count
              if (chatDocData.productId) {
                try {
                  const productDoc = await getDoc(doc(db, "products", chatDocData.productId));
                  if (productDoc.exists()) {
                    const productData = productDoc.data();
                    subscribersCount = productData.subscribers || productData.subscriberCount || 0;
                  }
                } catch (error) {
                  console.error("Error fetching product:", error);
                  // Fallback to random if product fetch fails
                  subscribersCount = Math.floor(Math.random() * 90000) + 10000;
                }
              } else {
                // Fallback to random number if no productId
                subscribersCount = Math.floor(Math.random() * 90000) + 10000;
              }

              return {
                ...chatDocData,
                id: chatId,
                amount: productAmount,
                otherParty: otherPartyName,
                subscribers: subscribersCount,
                status: transactionStatus,
                type: transactionType,
                userIcon: otherPartyIcon,
                creationDate: creationDate
              } as ChatWithTransactionData;
            }
            return null;
          });
          
          const chatResults = (await Promise.all(chatPromises)).filter(chat => chat !== null) as ChatWithTransactionData[];
          
          // Sort by creation date
          const sortedChats = chatResults.sort((a, b) => {
            const dateA = a.creationDate?.getTime() || 0;
            const dateB = b.creationDate?.getTime() || 0;
            return dateB - dateA; // Descending by date
          });
          
          setChats(sortedChats);
          // განვსაზღვრავთ გვერდების საერთო რაოდენობას
          setTotalPages(Math.ceil(sortedChats.length / itemsPerPage));
        } catch (error) {
          console.error("Error fetching chats:", error);
        } finally {
          setLoading(false);
        }
      };

      fetchChats();
    }
  }, [user, router, authLoading]); // Include authLoading in dependencies

  const handleFilterChange = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  const applyFilters = async () => {
    if (!user) return;
    
    try {
      setLoading(true);
      
      // Get all chats first
      const userChatListRef = collection(db, `users/${user.id}/chatList`);
      const chatListSnapshot = await getDocs(userChatListRef);
      
      const chatPromises = chatListSnapshot.docs.map(async (docSnapshot) => {
        const chatId = docSnapshot.id;
        const chatDoc = await getDoc(doc(db, "chats", chatId));
        
        if (chatDoc.exists()) {
          const chatDocData = chatDoc.data() as Chat;
              
          // Calculate the number of subscribers (participants)
          let subscriberCount = 0;
          if (chatDocData.participants) {
            subscriberCount = chatDocData.participants.length;
          } else if (chatDocData.participantPhotos) {
            subscriberCount = Object.keys(chatDocData.participantPhotos).length;
          }
          
          // Determine transaction type (Purchase/Sale)
          const transactionType = user.id === chatDocData.sellerId ? 'Sale' : 'Purchase';
          
          // Get the product amount
          const productAmount = chatDocData.productPrice || chatDocData.totalAmount || 0;
          
          // Determine the other party
          let otherPartyName = '';
          if (transactionType === 'Sale') {
            // If user is seller, get buyer name
            otherPartyName = chatDocData.participantNames?.[chatDocData.buyerId || ''] || 'Buyer';
          } else {
            // If user is buyer, get seller name
            otherPartyName = chatDocData.participantNames?.[chatDocData.sellerId || ''] || 'Seller';
          }
          
          // Create creation date from timestamp
          const creationDate = chatDocData.createdAt 
            ? new Date(typeof chatDocData.createdAt === 'number' ? chatDocData.createdAt : Date.now())
            : new Date();
          
          // Determine transaction status
          const transactionStatus = chatDocData.status || 
            (chatDocData.paymentStatus === 'completed' ? 'Completed' : 'Active');
            
          // Get other party's profile photo
          const otherPartyIcon = transactionType === 'Sale'
            ? chatDocData.participantPhotos?.[chatDocData.buyerId || ''] || '/agent.png' 
            : chatDocData.participantPhotos?.[chatDocData.sellerId || ''] || '/agent.png';

          // Get product subscribers count (if available)
          let subscribersCount = 0;
          
          // If chat has a productId, fetch the product details to get subscribers count
          if (chatDocData.productId) {
            try {
              const productDoc = await getDoc(doc(db, "products", chatDocData.productId));
              if (productDoc.exists()) {
                const productData = productDoc.data();
                subscribersCount = productData.subscribers || productData.subscriberCount || 0;
              }
            } catch (error) {
              console.error("Error fetching product:", error);
              // Fallback to random if product fetch fails
              subscribersCount = Math.floor(Math.random() * 90000) + 10000;
            }
          } else {
            // Fallback to random number if no productId
            subscribersCount = Math.floor(Math.random() * 90000) + 10000;
          }

          return {
            ...chatDocData,
            id: chatId,
            amount: productAmount,
            otherParty: otherPartyName,
            subscribers: subscribersCount,
            status: transactionStatus,
            type: transactionType,
            userIcon: otherPartyIcon,
            creationDate: creationDate
          } as ChatWithTransactionData;
        }
        return null;
      });
      
      let results = (await Promise.all(chatPromises)).filter(chat => chat !== null) as ChatWithTransactionData[];
      
      // Apply filters client-side
    if (filters.type !== 'All Types') {
        results = results.filter(chat => chat.type === filters.type);
    }
    
    if (filters.status !== 'All Status') {
        results = results.filter(chat => chat.status === filters.status);
    }
    
    if (filters.minAmount) {
        results = results.filter(chat => chat.amount >= Number(filters.minAmount));
    }
    
    if (filters.maxAmount) {
        results = results.filter(chat => chat.amount <= Number(filters.maxAmount));
    }
    
      // Sort by creation date (newest first)
      results = results.sort((a, b) => {
        const dateA = a.creationDate?.getTime() || 0;
        const dateB = b.creationDate?.getTime() || 0;
        return dateB - dateA;
      });
      
      setChats(results);
      // ფილტრების გამოყენებისას ვაბრუნებთ პირველ გვერდზე
      setCurrentPage(1);
      // ვითვლით გვერდების რაოდენობას
      setTotalPages(Math.ceil(results.length / itemsPerPage));
    } catch (error) {
      console.error("Error applying filters:", error);
    } finally {
      setLoading(false);
    }
  };

  // პაგინაციის ფუნქცია შეცვლის მიმდინარე გვერდს
  const handlePageChange = (newPage: number) => {
    if (newPage > 0 && newPage <= totalPages) {
      setCurrentPage(newPage);
    }
  };

  // Display loading state when auth is being checked
  if (authLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#6345ED]"></div>
      </div>
    );
  }

  // Only redirect if auth is done loading AND user is null
  if (!authLoading && !user) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <p>Redirecting to login...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Dark header */}
      <header className="bg-[#1E1E29] text-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            {/* Site logo */}
            <Link href="/" className="flex items-center">
              <span className="font-bold text-xl">Accs-market.com</span>
            </Link>
            
            <div className="flex items-center space-x-4">
              {/* Escrow service button */}
              <button className="bg-[#95D03A] hover:bg-opacity-90 text-white px-4 py-2 rounded-md">
                Escrow service
              </button>
              
              {/* Start selling button */}
              <button className="bg-[#6345ED] hover:bg-opacity-90 text-white px-4 py-2 rounded-md">
                Start selling
              </button>
              
              {/* User profile section */}
              <UserMenu />
            </div>
          </div>
        </div>
      </header>
      
      {/* Breadcrumb navigation */}
      <div className="bg-gray-100 border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2">
          <nav className="flex" aria-label="Breadcrumb">
            <ol className="flex items-center space-x-2">
              <li>
                <Link href="/" className="text-gray-600 hover:text-gray-900">Home page</Link>
              </li>
              <li className="flex items-center">
                <span className="mx-2 text-gray-400">&gt;</span>
                <span className="text-gray-900">My transactions</span>
              </li>
            </ol>
          </nav>
        </div>
      </div>
      
      {/* Main content area */}
      <main className="flex-grow bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-8">LIST OF YOUR TRANSACTIONS</h1>
          
          {/* Filter section */}
          <div className="bg-gray-50 p-4 rounded-lg mb-8">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              {/* Network filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Network</label>
                <select
                  name="network"
                  value={filters.network}
                  onChange={handleFilterChange}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#6345ED]"
                >
                  {networkOptions.map(option => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              
              {/* Type filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select
                  name="type"
                  value={filters.type}
                  onChange={handleFilterChange}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#6345ED]"
                >
                  {typeOptions.map(option => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              
              {/* Status filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  name="status"
                  value={filters.status}
                  onChange={handleFilterChange}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#6345ED]"
                >
                  {statusOptions.map(option => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              
              {/* Min/Max amount filters */}
              <div className="flex space-x-2">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Min Amount</label>
                  <input
                    type="number"
                    name="minAmount"
                    value={filters.minAmount}
                    onChange={handleFilterChange}
                    placeholder="Min $"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#6345ED]"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Max Amount</label>
                  <input
                    type="number"
                    name="maxAmount"
                    value={filters.maxAmount}
                    onChange={handleFilterChange}
                    placeholder="Max $"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#6345ED]"
                  />
                </div>
              </div>
              
              {/* Apply button */}
              <div className="flex items-end">
                <button
                  onClick={applyFilters}
                  className="w-full bg-[#6345ED] hover:bg-opacity-90 text-white px-4 py-2 rounded-md focus:outline-none"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
          
          {/* Transaction table */}
          <div className="overflow-x-auto">
            {loading ? (
              <div className="flex justify-center items-center py-10">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-[#6345ED]"></div>
              </div>
            ) : chats.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-gray-500">No transactions found.</p>
              </div>
            ) : (
            <table className="min-w-full bg-white border border-gray-200 rounded-lg">
              <thead className="bg-gray-50">
                <tr>
                  <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                  <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                  <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Subscribers</th>
                    <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Creation date</th>
                    <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Other party</th>
                    <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Transaction status / type</th>
                  <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                  {/* გვიჩვენებს მხოლოდ მიმდინარე გვერდის მონაცემებს */}
                  {chats.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage).map(chat => (
                    <tr key={chat.id} className="hover:bg-gray-50">
                    <td className="py-4 px-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="h-10 w-10 rounded-full overflow-hidden bg-gray-200">
                          <Image
                              src={chat.userIcon || '/agent.png'}
                            alt="User"
                            width={40}
                            height={40}
                            className="h-full w-full object-cover"
                          />
                        </div>
                      </div>
                    </td>
                      <td className="py-4 px-4 whitespace-nowrap font-medium">${chat.amount || 'N/A'}</td>
                      <td className="py-4 px-4 whitespace-nowrap">{chat.subscribers}</td>
                      <td className="py-4 px-4 whitespace-nowrap">
                        {chat.creationDate?.toLocaleDateString() || 'N/A'}
                      </td>
                      <td className="py-4 px-4 whitespace-nowrap">{chat.otherParty}</td>
                    <td className="py-4 px-4 whitespace-nowrap">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          chat.status === 'Active' ? 'bg-green-100 text-green-800' :
                          chat.status === 'Completed' ? 'bg-blue-100 text-blue-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                          {chat.status}/{chat.type}
                      </span>
                    </td>
                    <td className="py-4 px-4 whitespace-nowrap">
                        <Link href={`/my-chats?chatId=${chat.id}`}>
                      <button className="bg-[#6345ED] hover:bg-opacity-90 text-white px-3 py-1 rounded text-sm">
                        Open this transaction
                      </button>
                        </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </div>
          
          {/* Pagination */}
          {chats.length > 0 && (
          <div className="mt-5 flex justify-center">
            <nav className="flex items-center space-x-2">
                <button 
                  onClick={() => handlePageChange(currentPage - 1)} 
                  disabled={currentPage === 1}
                  className={`px-3 py-1 border rounded ${currentPage === 1 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}`}
                >
                  &lt;
                </button>
                
                {/* პირველი გვერდის ღილაკი მუდამ ჩანს */}
                <button 
                  onClick={() => handlePageChange(1)} 
                  className={`px-3 py-1 border rounded ${currentPage === 1 ? 'bg-[#6345ED] text-white' : 'hover:bg-gray-100'}`}
                >
                  1
                </button>

                {/* საჭიროებისამებრ ვაჩვენებთ "..." */}
                {currentPage > 3 && (
                  <span className="px-2">...</span>
                )}
                
                {/* ვაჩვენებთ მიმდინარე გვერდის წინა და შემდეგ გვერდებს */}
                {Array.from({length: Math.min(3, totalPages - 1)})
                  .map((_, i) => {
                    // გამოვთვალოთ, რომელი გვერდის ნომრები უნდა გამოჩნდეს
                    let pageNum;
                    if (currentPage <= 3) {
                      // თუ პირველ გვერდებზე ვართ
                      pageNum = i + 2;
                    } else if (currentPage >= totalPages - 2) {
                      // თუ ბოლო გვერდებზე ვართ
                      pageNum = totalPages - 3 + i + 1;
                    } else {
                      // სხვა შემთხვევაში ვაჩვენებთ: მიმდინარე-1, მიმდინარე, მიმდინარე+1
                      pageNum = currentPage - 1 + i;
                    }
                    
                    // მხოლოდ მაშინ ვაჩვენებთ, თუ გვერდის ნომერი 2-დან totalPages-1 შუალედშია
                    if (pageNum > 1 && pageNum < totalPages) {
                      return (
                        <button 
                          key={pageNum} 
                          onClick={() => handlePageChange(pageNum)} 
                          className={`px-3 py-1 border rounded ${currentPage === pageNum ? 'bg-[#6345ED] text-white' : 'hover:bg-gray-100'}`}
                        >
                          {pageNum}
                        </button>
                      );
                    }
                    return null;
                  })
                }

                {/* საჭიროებისამებრ ვაჩვენებთ "..." */}
                {currentPage < totalPages - 2 && (
                  <span className="px-2">...</span>
                )}
                
                {/* ბოლო გვერდის ღილაკი მუდამ ჩანს */}
                {totalPages > 1 && (
                  <button 
                    onClick={() => handlePageChange(totalPages)} 
                    className={`px-3 py-1 border rounded ${currentPage === totalPages ? 'bg-[#6345ED] text-white' : 'hover:bg-gray-100'}`}
                  >
                    {totalPages}
                  </button>
                )}
                
                <button 
                  onClick={() => handlePageChange(currentPage + 1)} 
                  disabled={currentPage === totalPages}
                  className={`px-3 py-1 border rounded ${currentPage === totalPages ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}`}
                >
                  &gt;
                </button>
            </nav>
          </div>
          )}
        </div>
      </main>
      
      {/* Footer */}
      <footer className="bg-[#1E1E29] text-white py-6">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row justify-between items-center">
            {/* Logo and address */}
            <div>
              <p className="text-gray-300 text-sm">
                MateSwap LP<br/>
                Address: 85 First Floor Great Portland Street, London, England, W1W 7LT
              </p>
            </div>
            
            {/* Links - გადატანილია მარჯვნივ */}
            <div className="flex space-x-6 mt-4 md:mt-0">
              <Link href="/terms" className="text-gray-300 hover:text-white text-sm">
                Terms and Conditions
              </Link>
              <Link href="/privacy" className="text-gray-300 hover:text-white text-sm">
                Privacy Policy
              </Link>
            </div>
          </div>
        </div>
      </footer>
      
      {/* Floating chat support button */}
      <div className="fixed bottom-6 right-6">
        <Link href="/my-chats" className="bg-[#6345ED] hover:bg-opacity-90 text-white w-14 h-14 rounded-full flex items-center justify-center shadow-lg">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" className="w-6 h-6">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </Link>
      </div>
    </div>
  );
} 