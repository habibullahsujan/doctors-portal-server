const express = require("express");
const cors = require("cors");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_API_KEY);

const app = express();
const port = process.env.PORT || 5000;

//middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster1.rvqsrsr.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

function verifyJWT(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) {
    return res.send("unauthorized");
  }
  const token = auth.split(" ")[1];
  jwt.verify(token, process.env.ACCESS_TOKEN, function (error, decoded) {
    if (error) {
      res.send("unauthorized");
    }
    req.decoded = decoded;
    next();
  });
}

async function run() {
  try {
    const appointmentScheduleCollection = client
      .db("doctors-portal")
      .collection("appointment-schedule");
    const appointmentBookingCollection = client
      .db("doctors-portal")
      .collection("appointment-booking-collection");

    const usersCollection = client.db("doctors-portal").collection("users");
    const doctorsCollection = client.db("doctors-portal").collection("doctors");
    const paymentCollection= client.db('doctors-portal').collection('payments')
  

    const verifyAdmin=async(req, res, next)=>{
     const email = req.decoded.email;
      const query = { user_email: email };
      const adminEmail = await usersCollection.findOne(query);
      if(adminEmail?.role !== 'admin'){
        return res.send('forbidden access')
      }
      next()
    }
    app.get("/appointmentSchedule", async (req, res) => {
      const date = req.query.date;

      const query = {};

      const treatments = await appointmentScheduleCollection
        .find(query)
        .toArray();
      //get time which is user selected;
      const bookingQuery = { appointmentDate: date };
      //find based on this time and get all the bookedAppointment for this date
      const alreadyBooked = await appointmentBookingCollection
        .find(bookingQuery)
        .toArray();
      // do something for each treatment
      treatments.forEach((treatment) => {
        //get all the treatment which already booked the user
        const bookedTreatment = alreadyBooked.filter(
          (booked) => booked.appointment_for === treatment.name
        );
        //get already booked slot for for the already booked treatment
        const alreadyBookedSchedule = bookedTreatment.map(
          (book) => book.appointmentTime
        );
        //get remaining slot for each treatment
        const remainingSchedule = treatment.slots.filter(
          (slot) => !alreadyBookedSchedule.includes(slot)
        );
        //set all remaining schedule in the all treatment
        treatment.slots = remainingSchedule;
      });

      res.send(treatments);
    });

    app.get("/v2/appointmentSchedule", async (req, res) => {
      const date = req.query.date;
      const options = await appointmentScheduleCollection
        .aggregate([
          {
            $lookup: {
              from: "appointment-booking-collection",
              localField: "name",
              foreignField: "appointment_for",
              as: "booked",
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ["$appointmentDate", date],
                    },
                  },
                },
              ],
            },
          },
          {
            $project: {
              name: 1,
              slots: 1,
              booked: {
                $map: {
                  input: "$booked",
                  as: "book",
                  in: "$$book.slot",
                },
              },
            },
          },
          {
            $project: {
              name: 1,
              slots: {
                $setDifference: ["$slots", "$booked"],
              },
            },
          },
        ])
        .toArray();
      res.send(options);
    });
    app.post("/appointmentBooking", async (req, res) => {
      const data = req.body;
      const query = {
        appointmentDate: data.appointmentDate,
        patientEmail: data.patientEmail,
      };

      const alreadyBooked = await appointmentBookingCollection
        .find(query)
        .toArray();
      if (alreadyBooked.length) {
        const message = "You already booked a appointment";
        return res.send({ acknowledge: false, message });
      }

      const result = await appointmentBookingCollection.insertOne(data);
      res.send(result);
    });

    app.get("/appointmentBooking", verifyJWT, async (req, res) => {
      const verify = req.decoded.email
      const email = req.query.email;
      if (verify !== email) {
        return res.send("forbidden -2");
      }
      const query = {
        patientEmail: email,
      };
      const appointments = await appointmentBookingCollection
        .find(query)
        .toArray();
      res.send(appointments);
    });
    app.post("/users", async (req, res) => {
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get("/jwt", async (req, res) => {
      const email = req.query.email;
      const query = { user_email: email };
      const user = usersCollection.findOne(query);
      if (user) {
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
          expiresIn: "1d",
        });
        return res.send({ accessToken: token });
      }
      res.status(401).send("unauthorized access");
    });
    app.post('/create-payment-intent', async(req, res)=>{
      const fee=req.body.fee;
      const amount=fee * 100;
      const paymentIntent=await  stripe.paymentIntents.create({
        amount:amount,
        currency:'usd', 
        "payment_method_types": [
          "card"
        ],
      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      });

    });
    app.post('/payment', async(req, res)=>{
      const info=req.body;
      const result= await paymentCollection.insertOne(info);
      const id=info.patientId
      const filter={_id:ObjectId(id)};
      const options = { upsert: true };
      const updatedDoc={
        $set:{
          paid:true

        }

      };
      const find=await appointmentBookingCollection.updateOne(filter, updatedDoc, options)
      res.send(result)
    })

    app.get("/users", async (req, res) => {
      const query = {};
      const allUsers = await usersCollection.find(query).toArray();
      res.send(allUsers);
    });

    app.put("/dashboard/admin/:id", verifyJWT, async (req, res) => {
      const email = req.decoded.email;
      const query = { user_email: email };
      const adminEmail = await usersCollection.findOne(query);

      if (adminEmail?.role !== "admin") {
        return res.send("forbidden access.");
      }
      const id = req.params.id;
      const filter = { _id: ObjectId(id) };
      const options = { upsert: true };
      const updatedDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await usersCollection.updateOne(
        filter,
        updatedDoc,
        options
      );
      res.send(result);
    });
    app.get("/admin/:email", async (req, res) => {
      const email = req.params.email;
      const admin = { user_email: email };
      const result = await usersCollection.findOne(admin);
      res.send({ isAdmin: result?.role === "admin" });
    });

    app.get('/doctorsSpecialty', async(req, res)=>{
      const query={};
      const result= await appointmentScheduleCollection.find(query).project({name:1}).toArray();
      res.send(result)
    });

    app.post('/add_doctors', verifyJWT, verifyAdmin, async(req, res)=>{
      const doctor=req.body;
      const result=await doctorsCollection.insertOne(doctor);
      res.send(result)
    });
    app.get('/doctors',async(req, res)=>{
      const query={};
      const doctors=await doctorsCollection.find(query).toArray();
      res.send(doctors)
    })
    app.delete('/doctors/:id',verifyJWT,verifyAdmin, async(req, res)=>{
      const id=req.params.id;
      const query={_id:ObjectId(id)};
      const result=await doctorsCollection.deleteOne(query);
      res.send(result)
    });
    app.get('/addPrice', async(req, res)=>{
      const query={};
      const options={upsert:true};
      const updatedDoc={
        $set:{
          price:2000,
        }
      };
      const result=await appointmentScheduleCollection.updateMany(query, updatedDoc, options);
      res.send(result)
    });
    app.get('/dashboard/payment/:id', async(req, res)=>{
      
      const id=req.params.id;
    
      const query={_id:ObjectId(id)};
      const result=await appointmentBookingCollection.findOne(query);

      res.send(result)
    })
  } catch (error) {}
}
run().catch((error) => console.error(error));

app.get("/", (req, res) => {
  res.send("express server is live now.");
});

app.listen(port, () => {
  console.log("Server is running in port:", port);
});
