const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const {
      name,
      email,
      company,
      phone,
      budget,
      timeline,
      description,
      referenceLink
    } = req.body;

    await resend.emails.send({
      from: "Vorexa Studio <onboarding@resend.dev>",
      to: "heyvorexa@gmail.com",
      subject: `New Inquiry from ${name}`,
      html: `
        <h2>New Inquiry</h2>

        <p><b>Name:</b> ${name}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>Company:</b> ${company}</p>
        <p><b>Phone:</b> ${phone}</p>
        <p><b>Budget:</b> ${budget}</p>
        <p><b>Timeline:</b> ${timeline}</p>
        <p><b>Description:</b><br>${description}</p>
        <p><b>Reference:</b> ${referenceLink}</p>
      `
    });

    return res.status(200).json({
      success: true
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Email sending failed"
    });
  }
};