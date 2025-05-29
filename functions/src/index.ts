import {onRequest} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import Stripe from "stripe";
import {onCall} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Firebase Admin SDK
admin.initializeApp();

// Stripe keys from environment variables
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

// HTTP function to create a Stripe Checkout session
export const createPaymentSessionHttp = onRequest(
  {cors: true},
  async (request, response) => {
    logger.info("createPaymentSessionHttp function triggered", {body: request.body});

    if (request.method !== "POST") {
      response.status(405).send("Method Not Allowed");
      return;
    }

    try {
      // Use direct Stripe key instead of fetching from Secret Manager
      const stripe = new Stripe(STRIPE_SECRET_KEY, {
        apiVersion: "2022-11-15" as Stripe.StripeConfig["apiVersion"],
      });

      const {chatId, userId, origin} = request.body;

      if (!chatId || !userId || !origin) {
        logger.error("Missing required parameters: chatId, userId, or origin");
        response.status(400).json({error: "Missing required parameters."});
        return;
      }

      logger.info("Fetching chat data for ID:", chatId);
      const chatDoc = await admin.firestore().collection("chats").doc(chatId).get();

      if (!chatDoc.exists) {
        logger.error(`Chat with ID ${chatId} not found`);
        response.status(404).json({error: "Chat not found"});
        return;
      }

      const chatData = chatDoc.data();
      const productId = chatData?.productId;

      if (!productId) {
        logger.error(`Product ID not found in chat ${chatId}`);
        response.status(404).json({error: "Product ID not found in chat"});
        return;
      }

      logger.info(`Fetching product data for ID: ${productId}`);
      const productDoc = await admin.firestore().collection("products").doc(productId).get();

      if (!productDoc.exists) {
        logger.error(`Product with ID ${productId} not found`);
        response.status(404).json({error: "Product not found"});
        return;
      }

      const productData = productDoc.data();
      const productPrice = productData?.price || 0;
      const productName = productData?.displayName || "Unknown Product";

      logger.info(`Product price: $${productPrice}, name: ${productName}`);

      const serviceFeePercent = 0.08; // 8%
      let calculatedServiceFee = productPrice * serviceFeePercent;

      // თუ 8% 3 დოლარზე ნაკლებია, საკომისიო იქნება 3 დოლარი
      if (calculatedServiceFee < 3) {
        calculatedServiceFee = 3;
      }
      
      // დამრგვალება ორ ათწილადამდე
      const roundedServiceFee = Math.round(calculatedServiceFee * 100) / 100;

      logger.info(`Calculated service fee: $${roundedServiceFee} (Logic: 8% of $${productPrice}, min $3)`);

      // მომხმარებელი იხდის მხოლოდ სერვისის საკომისიოს
      const totalAmount = roundedServiceFee;
      const roundedTotalAmount = Math.round(totalAmount * 100) / 100;

      logger.info(`Total amount: $${roundedTotalAmount} (Only service fee: $${roundedServiceFee})`);

      const priceInCents = Math.round(roundedTotalAmount * 100);
      const currency = "usd";
      const productDescription = `${productName} - ${serviceFeePercent * 100}% სერვისის საკომისიო`;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: currency,
              product_data: {
                name: `${productName} - სერვისის საკომისიო`,
                description: productDescription,
              },
              unit_amount: priceInCents,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${origin}/my-chats?chatId=${chatId}&payment=success`,
        cancel_url: `${origin}/my-chats?chatId=${chatId}&payment=cancelled`,
        client_reference_id: chatId,
        metadata: {
          chatId: chatId,
          userId: userId,
          productId: productId,
          productPrice: productPrice.toString(),
          serviceFee: roundedServiceFee.toString(),
          totalAmount: roundedTotalAmount.toString(),
        },
      });

      if (session.url) {
        logger.info("Stripe Checkout session created successfully:", {sessionId: session.id, url: session.url});

        try {
          await admin.firestore().collection("chats").doc(chatId).update({
            paymentSessionId: session.id,
            paymentStatus: "pending",
            feeAmount: roundedServiceFee,
            totalAmount: parseFloat(session.metadata?.totalAmount || "0"),
            productPrice: parseFloat(session.metadata?.productPrice || "0"),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          logger.info(`Updated chat ${chatId} with paymentSessionId ${session.id}`);
        } catch (updateError) {
          logger.error(`Failed to update chat with session ID: ${updateError}`);
        }

        response.status(200).json({url: session.url});
      } else {
        logger.error("Stripe session URL is null");
        response.status(500).json({error: "Failed to create payment session: No URL returned."});
      }
    } catch (error) {
      logger.error("Error creating Stripe Checkout session:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      response.status(500).json({error: `Failed to create payment session: ${errorMessage}`});
    }
  }
);

// Stripe webhook handler
export const stripeWebhook = onRequest(
  {cors: true},
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).send("Method Not Allowed");
      return;
    }

    const sig = request.headers["stripe-signature"];
    if (!sig) {
      response.status(400).send("Webhook Error: No Stripe signature found");
      return;
    }

    let event;

    try {
      // Use direct keys instead of fetching from Secret Manager
      const stripe = new Stripe(STRIPE_SECRET_KEY, {
        apiVersion: "2022-11-15" as Stripe.StripeConfig["apiVersion"],
      });

      const payload =
        request.rawBody ||
        (request.body
          ? typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body)
          : "");

      event = stripe.webhooks.constructEvent(payload, sig, STRIPE_WEBHOOK_SECRET);
      logger.info("Webhook verified:", event.type);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        if (session.payment_status === "paid") {
          const chatId = session.metadata?.chatId;
          const buyerId = session.metadata?.userId;
          const productId = session.metadata?.productId;
          const serviceFee = parseFloat(session.metadata?.serviceFee || "0");

          if (chatId) {
            logger.info(`Payment completed for chat: ${chatId}, user: ${buyerId}, product: ${productId}, fee: $${serviceFee}`);

            try {
              const chatDocRef = admin.firestore().collection("chats").doc(chatId);
              const chatDocSnapshot = await chatDocRef.get();
              
              let effectiveSellerId: string | undefined = undefined;
              const currentChatData = chatDocSnapshot.exists ? chatDocSnapshot.data()! : null;

              if (currentChatData) {
                if (currentChatData.sellerId) {
                  effectiveSellerId = currentChatData.sellerId;
                } else if (currentChatData.participants && buyerId) {
                  effectiveSellerId = currentChatData.participants.find((pId: string) => pId !== buyerId);
                }
              }

              const updatePayload: { [key: string]: any } = {
                paymentCompleted: true,
                paymentCompletedAt: Date.now(),
                paymentStatus: "completed",
                paymentSessionId: session.id,
                feeAmount: serviceFee,
                totalAmount: parseFloat(session.metadata?.totalAmount || "0"),
                productPrice: parseFloat(session.metadata?.productPrice || "0"),
              };

              if (effectiveSellerId && (!currentChatData || !currentChatData.sellerId)) {
                updatePayload.sellerId = effectiveSellerId;
              }

              await chatDocRef.update(updatePayload);
              logger.info(`Payment status updated for chat: ${chatId}.${updatePayload.sellerId ? ` SellerId was also updated to ${updatePayload.sellerId}.` : ''}`);
              
              const userDoc = await admin.firestore().collection("users").doc(buyerId || "").get();
              const buyerName = userDoc.exists ? userDoc.data()?.name || "Unknown User" : "Unknown User";

              const updatedChatInfoDoc = await chatDocRef.get();
              const chatDataForPaidRecord = updatedChatInfoDoc.exists ? updatedChatInfoDoc.data()! : {};
              const chatName = chatDataForPaidRecord.name || "Chat";
              
              let sellerName = "Unknown Seller";
              if (effectiveSellerId) {
                const sellerDoc = await admin.firestore().collection("users").doc(effectiveSellerId).get();
                sellerName = sellerDoc.exists ? sellerDoc.data()?.name || "Unknown Seller" : "Unknown Seller";
              }

              await admin.firestore().collection("paid").add({
                chatId: chatId,
                userId: buyerId,
                productId: productId,
                paymentSessionId: session.id,
                amount: serviceFee,
                totalAmount: parseFloat(session.metadata?.totalAmount || "0"),
                productPrice: parseFloat(session.metadata?.productPrice || "0"),
                status: "completed",
                paymentMethod: "stripe",
                currency: "usd",
                createdAt: Date.now(),
                stripeSessionId: session.id,
                buyerName: buyerName,
                sellerId: effectiveSellerId,
                sellerName: sellerName,
                chatName: chatName,
              });
              logger.info(`Payment record added to 'paid' collection for chat: ${chatId}`);

              try {
                const productDoc = await admin.firestore().collection("products").doc(productId || "").get();
                const productName = productDoc.exists ? productDoc.data()?.displayName || "Unknown Product" : "Unknown Product";

                await admin.firestore().collection("admin_notifications").add({
                  type: "payment_completed",
                  chatId: chatId || "",
                  productId: productId || "",
                  productName: productName,
                  buyerId: buyerId || "",
                  buyerName: buyerName,
                  paymentSessionId: session.id,
                  paymentAmount: serviceFee,
                  createdAt: Date.now(),
                  read: false,
                  priority: "high",
                  needsAction: true,
                  status: "pending_review",
                });
                logger.info(`Admin notification created for payment: ${session.id}`);

                await admin.database().ref(`adminNotifications/payment_${Date.now()}`).set({
                  type: "payment_completed",
                  chatId: chatId || "",
                  productId: productId || "",
                  productName: productName,
                  timestamp: Date.now(),
                  amount: serviceFee,
                });
                logger.info(`Real-time admin notification sent for payment: ${session.id}`);
              } catch (notificationError) {
                logger.error(`Failed to create admin notification: ${notificationError}`);
              }

              try {
                let adminPhotoURL = null;
                const chatDocForAdmin = await admin.firestore().collection("chats").doc(chatId).get();
                if (chatDocForAdmin.exists) {
                  const chatDataForAdmin = chatDocForAdmin.data();
                  adminPhotoURL = chatDataForAdmin?.adminPhotoURL || null;

                  if (!adminPhotoURL && chatDataForAdmin?.adminId) {
                    const adminDoc = await admin.firestore().collection("users").doc(chatDataForAdmin.adminId).get();
                    if (adminDoc.exists) {
                      adminPhotoURL = adminDoc.data()?.photoURL || null;
                    }
                  }
                }

                logger.info(`Payment confirmation logic removed for chat: ${chatId}`);
              } catch (messageError) {
                logger.error(`Failed to process payment confirmation: ${messageError}`);
              }
            } catch (err) {
              logger.error(`Failed to update chat payment status: ${err}`);
            }
          } else {
            logger.error("Missing chatId in session metadata");
          }
        } else {
          logger.info(`Payment not yet paid for session: ${session.id}, status: ${session.payment_status}`);
        }
      }

      response.json({received: true});
    } catch (err) {
      logger.error("Webhook signature verification failed:", err);
      response.status(400).send(`Webhook Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }
);

// Function to start a 7-day transfer timer
export const startTransferTimer = onCall(
  {enforceAppCheck: false},
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const {chatId} = request.data;

      if (!chatId) {
        throw new HttpsError("invalid-argument", "Chat ID is required.");
      }

      logger.info(`Starting 7-day transfer timer for chat: ${chatId}`);

      const chatDoc = await admin.firestore().collection("chats").doc(chatId).get();

      if (!chatDoc.exists) {
        throw new HttpsError("not-found", "Chat not found.");
      }

      const chatData = chatDoc.data();

      // შევამოწმოთ, რომ თვითონ ადმინი იწყებს ტაიმერს
      const userId = auth.uid;
      const userDoc = await admin.firestore().collection("users").doc(userId).get();
      
      if (!userDoc.exists) {
        throw new HttpsError("not-found", "User not found.");
      }
      
      const userData = userDoc.data();
      if (!userData?.isAdmin) {
        throw new HttpsError("permission-denied", "Only admins can start the transfer timer.");
      }

      if (!chatData?.paymentCompleted) {
        throw new HttpsError("failed-precondition", "Payment must be completed before starting transfer timer.");
      }

      const now = Date.now();
      const transferReadyTime = now + 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

      await admin.firestore().collection("chats").doc(chatId).update({
        transferTimerStarted: true,
        transferTimerStartedAt: now,
        transferReadyTime: transferReadyTime,
        transferStatus: "pending",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        adminJoined: true, // ყოველთვის დავაყენოთ ეს ფლაგი
        adminId: userId // შევინახოთ ადმინის ID
      });

      // ვამატებთ ლოგიკას, რომელიც შეამოწმებს ტაიმერის დასრულებას
      // და განაახლებს ჩატის სტატუსს
      const scheduleStatusUpdate = async () => {
        try {
          // შევამოწმოთ ტაიმერის დასრულების დრო
          const chatDocRef = admin.firestore().collection("chats").doc(chatId);
          const updatedChatDoc = await chatDocRef.get();
          
          if (!updatedChatDoc.exists) {
            logger.error(`Chat no longer exists: ${chatId}`);
            return;
          }
          
          const updatedChatData = updatedChatDoc.data();
          
          // შევამოწმოთ, რომ ტაიმერი ჯერ კიდევ აქტიურია
          if (!updatedChatData?.transferTimerStarted || !updatedChatData?.transferReadyTime) {
            logger.error(`Timer no longer active for chat: ${chatId}`);
            return;
          }
          
          // შევამოწმოთ, დასრულდა თუ არა ტაიმერი
          const currentTime = Date.now();
          
          if (currentTime >= updatedChatData.transferReadyTime) {
            // ტაიმერი დასრულდა - განვაახლოთ სტატუსი
            await chatDocRef.update({
              status: "awaiting_primary_transfer",
              transferReady: true,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // დავამატოთ სისტემური შეტყობინება ჩატში
            const messagesRef = admin.database().ref(`messages/${chatId}`);
            await messagesRef.push({
              text: "The 7-day waiting period has ended. The seller can now transfer primary ownership rights.",
              senderId: "system",
              senderName: "System",
              timestamp: currentTime,
              isSystem: true
            });
            
            logger.info(`Timer completed for chat ${chatId}, status updated to awaiting_primary_transfer`);
          }
        } catch (error) {
          logger.error(`Error checking timer status: ${error}`);
        }
      };
      
      // დავგეგმოთ სტატუსის განახლება 7 დღის შემდეგ
      // რეალურ სცენარში უმჯობესია გამოიყენოთ Cloud Scheduler ან მსგავსი სერვისი
      // მაგრამ ამ მაგალითში უბრალოდ setTimeout-ს ვიყენებთ
      const timeoutMs = transferReadyTime - now;
      setTimeout(scheduleStatusUpdate, timeoutMs);
      
      // შენიშვნა: ამ მიდგომის პრობლემა ის არის, რომ თუ ფუნქცია გადაიტვირთება,
      // დაგეგმილი განახლება დაიკარგება. რეალურ გარემოში საჭიროა უფრო
      // სანდო მექანიზმის გამოყენება, როგორიცაა Cloud Tasks ან Cloud Scheduler.

      const chatAdminId = chatData?.adminId;
      let adminPhotoURL = chatData?.adminPhotoURL || null;

      if (!adminPhotoURL && chatAdminId) {
        try {
          const adminDoc = await admin.firestore().collection("users").doc(chatAdminId).get();
          if (adminDoc.exists) {
            adminPhotoURL = adminDoc.data()?.photoURL || null;
          }
        } catch (err) {
          logger.warn(`Error fetching admin photo URL: ${err}`);
        }
      }

      return {
        success: true,
        transferReadyTime: transferReadyTime
      };
    } catch (error) {
      logger.error("Error starting transfer timer:", error);
      throw new HttpsError("internal", "Failed to start transfer timer: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);

// ახალი ფუნქცია გამყიდველის მიერ პირველადი მფლობელობის გადაცემის დასადასტურებლად
export const confirmPrimaryOwnershipTransfer = onCall(
  {enforceAppCheck: false},
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const {chatId} = request.data;

      if (!chatId) {
        throw new HttpsError("invalid-argument", "Chat ID is required.");
      }

      const userId = auth.uid;
      logger.info(`User ${userId} attempting to confirm primary ownership transfer for chat ${chatId}`);
      
      const chatDocRef = admin.firestore().collection("chats").doc(chatId);
      const chatDoc = await chatDocRef.get();

      if (!chatDoc.exists) {
        logger.error(`Chat ${chatId} not found`);
        throw new HttpsError("not-found", "Chat not found.");
      }

      const chatData = chatDoc.data();
      logger.info(`Chat data for ${chatId}:`, chatData);

      // ვამოწმებთ ყველა შესაძლო ვარიანტს თუ ვინ შეიძლება იყოს გამყიდველი
      let isSeller = false;
      
      // ვარიანტი 1: პირდაპირ არის მითითებული sellerId
      if (chatData?.sellerId === userId) {
        isSeller = true;
        logger.info(`User ${userId} is the seller (sellerId field)`);
      } 
      // ვარიანტი 2: მონაწილეა და პროდუქტის მფლობელია
      else if (chatData?.participants && chatData.participants.includes(userId) && chatData.productId) {
        try {
          const productDocRef = admin.firestore().collection("products").doc(chatData.productId);
          const productDoc = await productDocRef.get();
          
          if (productDoc.exists) {
            const productData = productDoc.data();
            if (productData?.userId === userId) {
              isSeller = true;
              logger.info(`User ${userId} is the seller (product owner)`);
              
              // თუ sellerId ველი არ არის დაყენებული, განვაახლოთ იგი
              if (!chatData.sellerId) {
                await chatDocRef.update({
                  sellerId: userId,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                logger.info(`Updated sellerId to ${userId} for chat ${chatId}`);
              }
            }
          }
        } catch (error) {
          logger.error(`Error checking product ownership: ${error}`);
        }
      }

      if (!isSeller) {
        logger.error(`User ${userId} is not verified as the seller for chat ${chatId}`);
        throw new HttpsError("permission-denied", "Only the seller can confirm primary ownership transfer.");
      }

      // შევამოწმოთ, რომ ჩატი სწორ სტატუსშია
      if (chatData?.status !== "awaiting_primary_transfer" || !chatData?.transferReady) {
        logger.error(`Chat ${chatId} is not in the correct state for primary ownership transfer. Status: ${chatData?.status}, transferReady: ${chatData?.transferReady}`);
        throw new HttpsError("failed-precondition", "Chat is not in the correct state for primary ownership transfer.");
      }

      const now = Date.now();

      // განვაახლოთ ჩატის სტატუსი
      await chatDocRef.update({
        primaryTransferInitiated: true,
        primaryTransferInitiatedAt: now,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // დავამატოთ სისტემური შეტყობინება ჩატში
      const messagesRef = admin.database().ref(`messages/${chatId}`);
      await messagesRef.push({
        text: "Seller has transferred primary ownership. Waiting for escrow agent confirmation.",
        senderId: "system",
        senderName: "System",
        timestamp: now,
        isSystem: true
      });

      // შევატყობინოთ ადმინს, რომ საჭიროა მისი ქმედება
      await admin.firestore().collection("admin_notifications").add({
        type: "primary_ownership_transferred",
        chatId: chatId,
        sellerId: userId,
        timestamp: now,
        read: false,
        priority: "high",
        message: `Seller has transferred primary ownership for chat: ${chatData?.name || chatId}. Please verify and confirm.`
      });

      logger.info(`Primary ownership transfer initiated by seller ${userId} for chat ${chatId}`);

      return {
        success: true
      };
    } catch (error) {
      logger.error("Error confirming primary ownership transfer:", error);
      throw new HttpsError("internal", "Failed to confirm transfer: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);

// ახალი ფუნქცია ადმინის მიერ პირველადი მფლობელობის დადასტურებისთვის
export const confirmPrimaryOwnershipByAdmin = onCall(
  {enforceAppCheck: false},
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const {chatId} = request.data;

      if (!chatId) {
        throw new HttpsError("invalid-argument", "Chat ID is required.");
      }

      const userId = auth.uid;
      const userDoc = await admin.firestore().collection("users").doc(userId).get();
      
      if (!userDoc.exists) {
        throw new HttpsError("not-found", "User not found.");
      }
      
      const userData = userDoc.data();
      if (!userData?.isAdmin) {
        throw new HttpsError("permission-denied", "Only admins can confirm primary ownership.");
      }

      const chatDocRef = admin.firestore().collection("chats").doc(chatId);
      const chatDoc = await chatDocRef.get();

      if (!chatDoc.exists) {
        throw new HttpsError("not-found", "Chat not found.");
      }

      const chatData = chatDoc.data();

      // შევამოწმოთ, რომ პირველადი მფლობელობის გადაცემა ინიცირებულია
      if (!chatData?.primaryTransferInitiated) {
        throw new HttpsError("failed-precondition", "Primary ownership transfer has not been initiated by the seller.");
      }

      const now = Date.now();
      const buyerId = chatData.participants.find((id: string) => id !== chatData.sellerId);

      // განვაახლოთ ჩატის სტატუსი
      await chatDocRef.update({
        primaryOwnerConfirmed: true,
        primaryOwnerConfirmedAt: now,
        owners: [buyerId], // გავაახლოთ მფლობელების სია
        status: "awaiting_buyer_payment",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // დავამატოთ სისტემური შეტყობინება ჩატში - შევცვალოთ ტექსტი, რომ დაემთხვეს ფრონტენდის ძებნის პირობებს
      const messagesRef = admin.database().ref(`messages/${chatId}`);
      await messagesRef.push({
        text: `Administrator ${userData.name || 'Admin'} has been assigned as primary owner.`,
        senderId: "system",
        senderName: "System",
        timestamp: now,
        isSystem: true
      });

      logger.info(`Primary ownership confirmed by admin ${userId} for chat ${chatId}`);

      return {
        success: true
      };
    } catch (error) {
      logger.error("Error confirming primary ownership by admin:", error);
      throw new HttpsError("internal", "Failed to confirm ownership: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);

// ახალი ფუნქცია მყიდველის მიერ გადახდის დადასტურებისთვის
export const confirmPaymentByBuyer = onCall(
  {enforceAppCheck: false},
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const {chatId} = request.data;

      if (!chatId) {
        throw new HttpsError("invalid-argument", "Chat ID is required.");
      }

      const userId = auth.uid;
      const chatDocRef = admin.firestore().collection("chats").doc(chatId);
      const chatDoc = await chatDocRef.get();

      if (!chatDoc.exists) {
        throw new HttpsError("not-found", "Chat not found.");
      }

      const chatData = chatDoc.data();

      // შევამოწმოთ, რომ მომხმარებელი ნამდვილად მყიდველია
      if (!chatData) {
        throw new HttpsError("not-found", "Chat data not found.");
      }
      
      logger.info(`[confirmPaymentByBuyer] Chat data for ${chatId}:`, {
        chatStatus: chatData.status || 'undefined',
        primaryOwnerConfirmed: chatData.primaryOwnerConfirmed || false,
        participants: chatData.participants || [],
        sellerId: chatData.sellerId || 'undefined',
        buyerId: chatData.buyerId || 'undefined',
        currentUserId: userId
      });
      
      const isBuyer = chatData.participants.includes(userId) && chatData.sellerId !== userId;
      if (!isBuyer) {
        throw new HttpsError("permission-denied", "Only the buyer can confirm payment.");
      }

      // შევამოწმოთ სისტემური შეტყობინებები ჩატში, ხომ არ შეიცავს "Administrator" და "assigned as primary owner"
      let primaryOwnershipMessageExists = false;
      try {
        const messagesRef = admin.database().ref(`messages/${chatId}`);
        const messagesSnapshot = await messagesRef.once('value');
        const messagesData = messagesSnapshot.val();

        if (messagesData) {
          // მესიჯების გადარჩევა და შემოწმება
          const messages = Object.values(messagesData);
          primaryOwnershipMessageExists = messages.some((msg: any) => {
            return msg.isSystem && 
              ((msg.text.includes('Administrator') && msg.text.includes('assigned as primary owner')) ||
               (msg.text.includes('ადმინისტრატორი') && msg.text.includes('დაინიშნა ძირითად მფლობელად')));
          });
        }
        logger.info(`[confirmPaymentByBuyer] Primary ownership message exists: ${primaryOwnershipMessageExists}`);
      } catch (error) {
        logger.error(`[confirmPaymentByBuyer] Error checking messages: ${error}`);
      }

      // შევამოწმოთ, რომ ჩატი სწორ სტატუსშია - დავამატოთ ახალი პირობა primaryOwnershipMessageExists
      if ((chatData?.status !== "awaiting_buyer_payment" || !chatData?.primaryOwnerConfirmed) && !primaryOwnershipMessageExists) {
        logger.error(`[confirmPaymentByBuyer] Chat is not in correct state: status=${chatData?.status}, primaryOwnerConfirmed=${chatData?.primaryOwnerConfirmed}, primaryOwnershipMessageExists=${primaryOwnershipMessageExists}`);
        throw new HttpsError(
          "failed-precondition", 
          `Chat is not in the correct state for payment confirmation. Status: ${chatData?.status || 'undefined'}, primaryOwnerConfirmed: ${chatData?.primaryOwnerConfirmed || false}, primaryOwnershipMessageExists: ${primaryOwnershipMessageExists}`
        );
      }

      const now = Date.now();

      // განვაახლოთ ჩატის სტატუსი - ასევე დავაყენოთ primaryOwnerConfirmed თუ ის არ არის უკვე დაყენებული
      const updateData: any = {
        paymentStatus: "paid",
        paymentConfirmedByBuyer: true,
        paymentConfirmedByBuyerAt: now,
        status: "awaiting_seller_confirmation",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      // თუ primaryOwnershipMessageExists არის true, მაგრამ primaryOwnerConfirmed არ არის true, განვაახლოთ ეს ველიც
      if (primaryOwnershipMessageExists && !chatData.primaryOwnerConfirmed) {
        updateData.primaryOwnerConfirmed = true;
        updateData.primaryOwnerConfirmedAt = now;
        logger.info(`[confirmPaymentByBuyer] Setting primaryOwnerConfirmed to true based on system message`);
      }

      await chatDocRef.update(updateData);

      // დავამატოთ სისტემური შეტყობინება ჩატში
      const messagesRef = admin.database().ref(`messages/${chatId}`);
      await messagesRef.push({
        text: "Buyer has confirmed payment. Waiting for seller to confirm receipt.",
        senderId: "system",
        senderName: "System",
        timestamp: now,
        isSystem: true
      });

      logger.info(`Payment confirmed by buyer ${userId} for chat ${chatId}`);

      return {
        success: true
      };
    } catch (error) {
      logger.error("Error confirming payment by buyer:", error);
      throw new HttpsError("internal", "Failed to confirm payment: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);

// ახალი ფუნქცია გამყიდველის მიერ გადახდის მიღების დადასტურებისთვის
export const confirmPaymentReceived = onCall(
  {enforceAppCheck: false},
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const {chatId} = request.data;

      if (!chatId) {
        throw new HttpsError("invalid-argument", "Chat ID is required.");
      }

      const userId = auth.uid;
      const chatDocRef = admin.firestore().collection("chats").doc(chatId);
      const chatDoc = await chatDocRef.get();

      if (!chatDoc.exists) {
        throw new HttpsError("not-found", "Chat not found.");
      }

      const chatData = chatDoc.data();

      // შევამოწმოთ, რომ მომხმარებელი ნამდვილად გამყიდველია ან ადმინი
      if (chatData?.sellerId !== userId && !auth.token.admin) {
        throw new HttpsError("permission-denied", "Only the seller or admin can confirm payment receipt.");
      }

      // შევამოწმოთ, რომ ჩატი სწორ სტატუსშია
      if (
        // თუ სტატუსი არ არის awaiting_seller_confirmation
        chatData?.status !== "awaiting_seller_confirmation" && 
        // და ასევე არ არის რომელიმე სტატუსი სადაც მყიდველმა დაადასტურა გადახდა
        !(
          (chatData?.paymentConfirmedByBuyer === true || chatData?.buyerConfirmedPayment === true) && 
          // და გამყიდველს ჯერ არ დაუდასტურებია მიღება
          chatData?.sellerConfirmedReceipt !== true
        )
      ) {
        logger.error(`[confirmPaymentReceived] Chat is not in correct state: status=${chatData?.status}, paymentConfirmedByBuyer=${chatData?.paymentConfirmedByBuyer}, buyerConfirmedPayment=${chatData?.buyerConfirmedPayment}, sellerConfirmedReceipt=${chatData?.sellerConfirmedReceipt}`);
        throw new HttpsError("failed-precondition", "Chat is not in the correct state for payment receipt confirmation.");
      }

      const now = Date.now();
      const productPrice = chatData.productPrice || 0;

      // განვაახლოთ ჩატის სტატუსი
      await chatDocRef.update({
        status: "completed",
        closedAt: now,
        closedBy: "seller",
        escrowActive: false,
        sellerConfirmedReceipt: true,
        paymentReceiptConfirmedAt: now,
        paymentStatus: "completed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // განვაახლოთ გამყიდველის ქულები
      const sellerDocRef = admin.firestore().collection("users").doc(userId);
      await sellerDocRef.update({
        score: admin.firestore.FieldValue.increment(productPrice)
      });

      // დავამატოთ სისტემური შეტყობინება ჩატში
      const messagesRef = admin.database().ref(`messages/${chatId}`);
      await messagesRef.push({
        text: "Seller has confirmed payment receipt. Transaction completed successfully!",
        senderId: "system",
        senderName: "System",
        timestamp: now,
        isSystem: true
      });

      logger.info(`Payment receipt confirmed by seller ${userId} for chat ${chatId}`);

      return {
        success: true,
        pointsAdded: productPrice
      };
    } catch (error) {
      logger.error("Error confirming payment receipt:", error);
      throw new HttpsError("internal", "Failed to confirm payment receipt: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);

// Function to invite an admin to a private chat
export const inviteAdminToPrivateChat = onCall(
  {enforceAppCheck: false},
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const {chatId, adminEmail, transactionId, initialMessage, productName} = request.data;

      if (!chatId || !adminEmail) {
        throw new HttpsError("invalid-argument", "Chat ID and admin email are required.");
      }

      const currentUserId = auth.uid;
      const chatDoc = await admin.firestore().collection("chats").doc(chatId).get();

      if (!chatDoc.exists) {
        throw new HttpsError("not-found", "Chat not found.");
      }

      const chatData = chatDoc.data();
      const participants = chatData?.participants || [];
      let sellerId = chatData?.sellerId;

      if (!sellerId && participants.length > 1) {
        if (participants.includes(currentUserId)) {
          sellerId = currentUserId;
        } else {
          throw new HttpsError("permission-denied", "Only the seller can invite admins to a private chat.");
        }
      }

      if (sellerId !== currentUserId) {
        throw new HttpsError("permission-denied", "Only the seller can invite admins to a private chat.");
      }

      const usersSnapshot = await admin.firestore().collection("users").where("email", "==", adminEmail).where("isAdmin", "==", true).get();

      if (usersSnapshot.empty) {
        throw new HttpsError("not-found", "No admin found with this email.");
      }

      const adminData = usersSnapshot.docs[0].data();
      const adminId = usersSnapshot.docs[0].id;
      const adminPhotoURL = adminData.photoURL || null;

      const newChatRef = admin.firestore().collection("chats").doc();
      const newChatId = newChatRef.id;

      const sellerDoc = await admin.firestore().collection("users").doc(sellerId).get();
      const sellerData = sellerDoc.data();
      const sellerName = sellerData?.name || "Unknown Seller";
      const sellerPhotoURL = sellerData?.photoURL || null;

      const chatName = `${adminData.name} & ${sellerName} - Private`;
      const now = Date.now();
      const privateChat = {
        id: newChatId,
        participants: [sellerId, adminId],
        participantNames: {
          [sellerId]: sellerName,
          [adminId]: adminData.name,
        },
        name: chatName,
        participantPhotos: {
          [sellerId]: sellerPhotoURL,
          [adminId]: adminPhotoURL,
        },
        createdAt: now,
        updatedAt: now,
        isPrivateWithAdmin: true,
        originalChatId: chatId,
        adminJoined: true,
        adminId: adminId,
        adminPhotoURL: adminPhotoURL,
        sellerId: sellerId,
        productId: chatData?.productId || "",
        productName: chatData?.productName || productName || "Unknown Product",
      };

      let adminUserDoc;
      try {
        adminUserDoc = await admin.firestore().collection("users").doc(adminId).get();
      } catch (err) {
        logger.warn(`Error fetching admin user document: ${err}`);
      }

      if (adminUserDoc && adminUserDoc.exists) {
        const adminUserData = adminUserDoc.data();
        if (adminUserData?.adminPhotoURL) {
          privateChat.adminPhotoURL = adminUserData.adminPhotoURL;
        } else if (adminUserData?.photoURL) {
          privateChat.adminPhotoURL = adminUserData.photoURL;
        }
      }

      await newChatRef.set(privateChat);

      const rtdbRef = admin.database().ref(`messages/${newChatId}`);
      const welcomeMessage = {
        text: initialMessage || `გამყიდველმა მოიწვია ესქროუ აგენტი ტრანზაქციისთვის #${transactionId || chatId.substring(0, 6)}.\nმოწვეული ადმინი: ${adminEmail}`,
        senderId: "system",
        senderName: "System",
        timestamp: now,
        isSystem: true,
        senderPhotoURL: adminPhotoURL,
      };

      await rtdbRef.push(welcomeMessage);

      await admin.firestore().collection("chats").doc(chatId).update({
        hasPrivateAdminChat: true,
        privateAdminChatId: newChatId,
        privateAdminChatCreatedAt: now,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        adminId: adminId,
        adminPhotoURL: privateChat.adminPhotoURL || adminPhotoURL,
      });

      const originalChatRtdbRef = admin.database().ref(`messages/${chatId}`);
      await originalChatRtdbRef.push({
        text: `გამყიდველმა მოიწვია ესქროუ აგენტი (${adminData.name}) ამ ტრანზაქციის დასახმარებლად.`,
        senderId: "system",
        senderName: "System",
        timestamp: now,
        isSystem: true,
        senderPhotoURL: adminPhotoURL,
      });

      logger.info(`Private admin chat created: ${newChatId} between seller ${sellerId} and admin ${adminId}`);

      return {
        success: true,
        privateChatId: newChatId,
      };
    } catch (error) {
      logger.error("Error inviting admin to private chat:", error);
      throw new HttpsError("internal", "Failed to invite admin: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);

// Function for an admin to officially join a chat
export const adminJoinChat = onCall(
  {enforceAppCheck: false},
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const {chatId} = request.data;

      if (!chatId) {
        throw new HttpsError("invalid-argument", "Chat ID is required.");
      }

      // Get user data to confirm they are an admin
      const userId = auth.uid;
      const userDoc = await admin.firestore().collection("users").doc(userId).get();
      
      if (!userDoc.exists) {
        throw new HttpsError("not-found", "User not found.");
      }
      
      const userData = userDoc.data();
      if (!userData?.isAdmin) {
        throw new HttpsError("permission-denied", "Only admins can join as an admin.");
      }

      const chatDoc = await admin.firestore().collection("chats").doc(chatId).get();
      if (!chatDoc.exists) {
        throw new HttpsError("not-found", "Chat not found.");
      }

      const chatData = chatDoc.data();
      
      // Check if the admin is assigned to this chat
      if (chatData?.adminId && chatData.adminId !== userId) {
        throw new HttpsError("permission-denied", "Another admin is already assigned to this chat.");
      }

      const now = Date.now();
      const adminName = userData.name || "Admin";
      const adminPhotoURL = userData.adminPhotoURL || userData.photoURL || null;

      await admin.firestore().collection("chats").doc(chatId).update({
        adminJoined: true,
        adminJoinedAt: now,
        adminId: userId,
        adminPhotoURL: adminPhotoURL,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Admin ${userId} (${adminName}) joined chat ${chatId} at ${new Date(now).toISOString()}`);

      return {
        success: true,
        joinedAt: now,
      };
    } catch (error) {
      logger.error("Error joining chat as admin:", error);
      throw new HttpsError("internal", "Failed to join chat: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);

// Function to fetch all admin emails
export const getAdminEmails = onCall(
  {enforceAppCheck: false},
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const usersSnapshot = await admin.firestore().collection("users").where("isAdmin", "==", true).get();

      if (usersSnapshot.empty) {
        return {adminEmails: []};
      }

      const adminEmails = usersSnapshot.docs
        .map((doc) => {
          const userData = doc.data();
          return userData.email || "";
        })
        .filter((email) => email !== "");

      return {adminEmails};
    } catch (error) {
      logger.error("Error fetching admin emails:", error);
      throw new HttpsError("internal", "Failed to fetch admin emails: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);

// Function for seller to confirm offer
export const confirmSellerOffer = onCall(
  {enforceAppCheck: false}, // Consider enabling App Check for production
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const {chatId} = request.data;

      if (!chatId || typeof chatId !== "string") {
        throw new HttpsError("invalid-argument", "Chat ID is required and must be a string.");
      }

      const currentUserId = auth.uid;
      logger.info(`User ${currentUserId} attempting to confirm offer for chat ${chatId}`);
      
      const chatDocRef = admin.firestore().collection("chats").doc(chatId);
      const chatDoc = await chatDocRef.get();

      if (!chatDoc.exists) {
        logger.error(`Chat ${chatId} not found`);
        throw new HttpsError("not-found", "Chat not found.");
      }

      const chatData = chatDoc.data();
      if (!chatData) {
        logger.error(`Chat data is missing for chat ${chatId}`);
        throw new HttpsError("data-loss", "Chat data is missing.");
      }
      logger.info(`Chat data for ${chatId}:`, chatData);

      // ვამოწმებთ ყველა შესაძლო ვარიანტს თუ ვინ შეიძლება იყოს გამყიდველი
      let isSeller = false;
      
      // ვარიანტი 1: პირდაპირ არის მითითებული sellerId
      if (chatData.sellerId === currentUserId) {
        isSeller = true;
        logger.info(`User ${currentUserId} is the seller (sellerId field)`);
      } 
      // ვარიანტი 2: მონაწილეა და პროდუქტის მფლობელია
      else if (chatData.participants && chatData.participants.includes(currentUserId) && chatData.productId) {
        try {
          const productDocRef = admin.firestore().collection("products").doc(chatData.productId);
          const productDoc = await productDocRef.get();
          
          if (productDoc.exists) {
            const productData = productDoc.data();
            if (productData?.userId === currentUserId) {
              isSeller = true;
              logger.info(`User ${currentUserId} is the seller (product owner)`);
              
              // თუ sellerId ველი არ არის დაყენებული, განვაახლოთ იგი
              if (!chatData.sellerId) {
                await chatDocRef.update({
                  sellerId: currentUserId,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                logger.info(`Updated sellerId to ${currentUserId} for chat ${chatId}`);
              }
            }
          }
        } catch (error) {
          logger.error(`Error checking product ownership: ${error}`);
        }
      }
      
      // ვარიანტი 3: თუ მხოლოდ ორი მონაწილეა, და ერთი მათგანი არის ბაიერი, ხოლო მეორე გამყიდველი
      else if (chatData.participants && chatData.participants.length === 2 && chatData.buyerId && chatData.buyerId !== currentUserId && chatData.participants.includes(currentUserId)) {
        isSeller = true;
        logger.info(`User ${currentUserId} is the seller (by elimination - not buyer, but participant)`);
        
        // განვაახლოთ sellerId ველი
        await chatDocRef.update({
          sellerId: currentUserId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        logger.info(`Updated sellerId to ${currentUserId} for chat ${chatId}`);
      }

      if (!isSeller) {
        logger.error(`User ${currentUserId} is not verified as the seller for chat ${chatId}`);
        throw new HttpsError("permission-denied", "Only the seller can confirm the offer.");
      }

      if (chatData?.sellerConfirmed) {
        logger.info(`Offer for chat ${chatId} already confirmed by seller.`);
        return {success: true, message: "Offer already confirmed."};
      }

      await chatDocRef.update({
        sellerConfirmed: true,
        sellerConfirmedAt: admin.firestore.FieldValue.serverTimestamp(), // Use server timestamp
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Seller ${currentUserId} confirmed offer for chat ${chatId}`);

      return {success: true};
    } catch (error: unknown) {
      logger.error("Error confirming seller offer:", error);
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError("internal", "Failed to confirm seller offer: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);

// Function to assign manager rights to an escrow agent
export const assignManagerRightsToAdmin = onCall(
  {enforceAppCheck: false}, // Consider App Check for production
  async (request) => {
    try {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const { chatId, adminEmail } = request.data;

      if (!chatId || typeof chatId !== "string") {
        throw new HttpsError("invalid-argument", "Chat ID is required and must be a string.");
      }
      if (!adminEmail || typeof adminEmail !== "string") {
        throw new HttpsError("invalid-argument", "Admin email is required and must be a string.");
      }

      const currentUserId = auth.uid;
      logger.info(`User ${currentUserId} attempting to assign manager rights for chat ${chatId} to admin ${adminEmail}`);
      
      const chatDocRef = admin.firestore().collection("chats").doc(chatId);
      const chatDoc = await chatDocRef.get();

      if (!chatDoc.exists) {
        logger.error(`Chat ${chatId} not found`);
        throw new HttpsError("not-found", "Chat not found.");
      }

      const chatData = chatDoc.data();
      if (!chatData) {
        logger.error(`Chat data is missing for chat ${chatId}`);
        throw new HttpsError("data-loss", "Chat data is missing.");
      }
      logger.info(`Chat data for ${chatId}:`, chatData);

      // ვამოწმებთ ყველა შესაძლო ვარიანტს თუ ვინ შეიძლება იყოს გამყიდველი
      let isSeller = false;
      
      // ვარიანტი 1: პირდაპირ არის მითითებული sellerId
      if (chatData.sellerId === currentUserId) {
        isSeller = true;
        logger.info(`User ${currentUserId} is the seller (sellerId field)`);
      } 
      // ვარიანტი 2: მონაწილეა და პროდუქტის მფლობელია
      else if (chatData.participants && chatData.participants.includes(currentUserId) && chatData.productId) {
        try {
          const productDocRef = admin.firestore().collection("products").doc(chatData.productId);
          const productDoc = await productDocRef.get();
          
          if (productDoc.exists) {
            const productData = productDoc.data();
            if (productData?.userId === currentUserId) {
              isSeller = true;
              logger.info(`User ${currentUserId} is the seller (product owner)`);
              
              // თუ sellerId ველი არ არის დაყენებული, განვაახლოთ იგი
              if (!chatData.sellerId) {
                await chatDocRef.update({
                  sellerId: currentUserId,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                logger.info(`Updated sellerId to ${currentUserId} for chat ${chatId}`);
              }
            }
          }
        } catch (error) {
          logger.error(`Error checking product ownership: ${error}`);
        }
      }

      if (!isSeller) {
        logger.error(`User ${currentUserId} is not verified as the seller for chat ${chatId}`);
        throw new HttpsError("permission-denied", "Only the seller can assign manager rights.");
      }

      // Find the admin user by email
      const adminUsersSnapshot = await admin.firestore().collection("users").where("email", "==", adminEmail).where("isAdmin", "==", true).get();

      if (adminUsersSnapshot.empty) {
        logger.error(`Admin user with email ${adminEmail} not found or is not an admin`);
        throw new HttpsError("not-found", `Admin user with email ${adminEmail} not found or is not an admin.`);
      }
      const adminUserDoc = adminUsersSnapshot.docs[0];
      const adminId = adminUserDoc.id;

      const now = Date.now();
      await chatDocRef.update({
        escrowAgentAdminId: adminId,
        escrowAgentAdminEmail: adminEmail,
        escrowAgentAssignedAt: now,
        managerRightsAssigned: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Manager rights for chat ${chatId} assigned to admin ${adminId} (${adminEmail}) by seller ${currentUserId}.`);

      // Create a notification for the admin
      await admin.firestore().collection("admin_notifications").add({
        type: "manager_rights_assigned",
        chatId: chatId,
        originalChatId: chatData.originalChatId || chatId, // If it's a private admin chat, link to original
        adminId: adminId,
        adminEmail: adminEmail,
        assignedBySellerId: currentUserId,
        productName: chatData.productName || "Unknown Product",
        timestamp: now,
        read: false,
        priority: "high",
        message: `Seller ${auth.token.name || currentUserId} has assigned you manager rights for chat: ${chatData.name || chatId}. Product: ${chatData.productName || "N/A"}.`,
      });
      logger.info(`Admin notification created for manager rights assignment in chat ${chatId} to admin ${adminId}.`);

      return { success: true, message: `Manager rights assigned to ${adminEmail}.` };

    } catch (error: unknown) {
      logger.error("Error assigning manager rights to admin:", error);
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError("internal", "Failed to assign manager rights: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  }
);