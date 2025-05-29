// create-all-collections.js
// სკრიპტი, რომელიც ქმნის Firebase-ის ყველა საჭირო კოლექციას

// Firebase-ის SDK იმპორტი
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc } = require('firebase/firestore');
const { config } = require('dotenv');

// დოტენვის კონფიგურაციას ვტვირთავთ
config();

// Firebase კონფიგურაცია
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
};

// Firebase ინიციალიზაცია
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ეს არის კოლექციების სია, რომლებიც უნდა შეიქმნას
const collections = [
  'users',
  'products',
  'chats',
  'reviews',
  'admin_notifications',
  'paid',
  'channelLogos',
  'productViews',
  'featured_products',
  'product_categories'
];

// ფუნქცია, რომელიც ქმნის ყველა საჭირო კოლექციას
async function createAllCollections() {
  try {
    console.log('Starting to create collections...');
    
    for (const collectionName of collections) {
      // ვქმნით დოკუმენტს placeholder_doc_id-ით კოლექციაში, რომ კოლექცია შეიქმნას
      const docRef = doc(db, collectionName, 'placeholder_doc_id');
      await setDoc(docRef, {
        createdAt: new Date().toISOString(),
        info: `This is a placeholder document for ${collectionName} collection`,
        isPlaceholder: true
      });
      
      console.log(`Created collection: ${collectionName}`);
    }
    
    console.log('All collections have been created successfully!');
  } catch (error) {
    console.error('Error creating collections:', error);
  }
}

// სკრიპტის გაშვება
createAllCollections();
