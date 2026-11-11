"""Synthetic fixtures carried over from the prototype. Fictional. Never real Finvasia data."""

DEMO_PASSWORD = "TrainCheck123!"

DEPARTMENTS = [("OPS", "Operations"), ("CX", "Customer Experience"), ("LND", "Learning & Development"), ("HR", "Human Resources")]
FUNCTIONS = [("COMPLIANCE", "Compliance"), ("SUPPORT", "Customer Support"), ("OPERATIONS", "Operations"), ("SALES", "Sales"), ("TECH", "Technology")]
LOCATIONS = [("LOC-A", "Demo location A"), ("LOC-B", "Demo location B")]
TRAINERS = ["Riya Anand", "Sanjay Verma"]

# code, name, email, department, function, grade, manager code
EMPLOYEES = [
    ("M001", "Neha Kapoor", "manager@traincheck.demo", "OPS", "OPERATIONS", "Demo G3", None),
    ("M002", "Kabir Das", "manager2@traincheck.demo", "CX", "SUPPORT", "Demo G3", None),
    ("A001", "Riya Anand", "admin@traincheck.demo", "LND", None, "Demo G3", None),
    ("H001", "Dev Malhotra", "hr@traincheck.demo", "HR", None, "Demo G4", None),
    ("E001", "Aarav Mehta", "employee@traincheck.demo", "OPS", "COMPLIANCE", "Demo G1", "M001"),
    ("E002", "Isha Rao", "clear@traincheck.demo", "OPS", "COMPLIANCE", "Demo G2", "M001"),
    ("E003", "Rohan Sen", "e003@traincheck.demo", "OPS", "OPERATIONS", "Demo G2", "M001"),
    ("E004", "Maya Shah", "e004@traincheck.demo", "OPS", "OPERATIONS", "Demo G1", "M001"),
    ("E005", "Vikram Sethi", "e005@traincheck.demo", "OPS", "TECH", "Demo G2", "M001"),
    ("E006", "Tara Nair", "e006@traincheck.demo", "CX", "SUPPORT", "Demo G1", "M002"),
    ("E007", "Arjun Roy", "e007@traincheck.demo", "CX", "SUPPORT", "Demo G2", "M002"),
    ("E008", "Sara Jain", "e008@traincheck.demo", "CX", "SALES", "Demo G2", "M002"),
    ("E009", "Neil Bose", "e009@traincheck.demo", "CX", "SALES", "Demo G1", "M002"),
    ("E010", "Anika Sood", "e010@traincheck.demo", "CX", "SUPPORT", "Demo G2", "M002"),
]

ROLES = {"M001": ["MANAGER", "EMPLOYEE"], "M002": ["MANAGER", "EMPLOYEE"], "A001": ["LD_ADMIN", "EMPLOYEE"], "H001": ["HR_READ_ONLY", "EMPLOYEE"]}

COMPETENCIES = [
    ("Applies the documented process", "Uses the training's process accurately in relevant work."),
    ("Recognises and escalates exceptions", "Seeks guidance and escalates cases outside their authority."),
    ("Customer communication", "Explains clearly and listens to the customer's concern."),
    ("Complaint handling and resolution", "Resolves complaints fairly and records the outcome."),
    ("Process accuracy and discipline", "Completes operational steps correctly and on time."),
    ("KYC procedure adherence", "Follows each verification step and keeps a traceable record."),
    ("Security practices", "Protects accounts and data and reports suspicious activity."),
]

TRAININGS = [
    {
        "code": "T001",
        "title": "KYC & AML Compliance",
        "category": "Compliance",
        "description": "Recognise risk indicators and follow a consistent customer verification process.",
        "pretest": True,
        "competencies": ["Applies the documented process", "Recognises and escalates exceptions", "KYC procedure adherence"],
    },
    {
        "code": "T002",
        "title": "Customer Handling",
        "category": "Customer experience",
        "description": "Build clear conversations, protect privacy and resolve customer concerns.",
        "pretest": False,
        "competencies": ["Customer communication", "Complaint handling and resolution"],
    },
    {
        "code": "T003",
        "title": "Cybersecurity Awareness",
        "category": "Information security",
        "description": "Recognise threats and protect customer and company information.",
        "pretest": True,
        "competencies": ["Security practices", "Recognises and escalates exceptions"],
    },
]

REFRESHER_TEXT = "Review the training material. Follow the documented process, record relevant facts and ask the designated owner when unsure."

# topic, question, correct option, then the wrong options. Option order is shuffled at each attempt.
QUESTION_BANKS = {
    "T001": [
        ("Identity checks", "A customer submits incomplete identity documents. What should you do?", "Follow the verification checklist and request missing information", "Skip the missing fields", "Approve based on a verbal promise", "Use another customer's record"),
        ("Risk awareness", "You notice unusual account activity. What is the appropriate next step?", "Escalate through the designated internal process", "Ignore it until the customer complains", "Discuss the customer on social media", "Promise that no review will occur"),
        ("Data handling", "Which approach protects customer information?", "Use approved systems and authorised access", "Share documents in personal chat", "Save documents on a shared public drive", "Reuse customer passwords"),
        ("Identity checks", "Why should verification steps be documented?", "To keep a traceable record of the checks performed", "To replace all future checks", "To guarantee a risk-free account", "To avoid internal review"),
        ("Risk awareness", "A colleague asks you to bypass a required check. What should you do?", "Follow the approved process and raise the concern", "Bypass it for a colleague", "Delete the checklist", "Let the customer decide"),
        ("Data handling", "Who should access a customer verification file?", "Only authorised people with a work-related need", "Every employee", "Anyone with the link", "All customers"),
        ("Identity checks", "A document conflicts with information in an application. What is appropriate?", "Clarify the discrepancy using the approved process", "Choose whichever value looks better", "Change the document yourself", "Ignore the discrepancy"),
        ("Risk awareness", "What does a risk indicator mean?", "It calls for review under the applicable process", "It proves wrongdoing", "It permits public disclosure", "It removes the need for documentation"),
        ("Data handling", "Customer verification records should be shared only through approved secure channels.", "True", "False"),
        ("Identity checks", "What should you do when unsure about a verification requirement?", "Consult the approved guidance or designated support", "Invent a new requirement", "Skip verification", "Copy an unrelated case"),
    ],
    "T002": [
        ("Communication", "A customer is upset about a delay. What should you do first?", "Listen and acknowledge the concern", "Interrupt with a sales pitch", "Promise an unverified resolution time", "End the conversation"),
        ("Resolution", "What makes a useful case note?", "A factual summary and agreed next steps", "Personal judgements", "Only the customer's name", "An invented resolution"),
        ("Communication", "How should you explain an unfamiliar product term?", "Use plain language and check understanding", "Use more jargon", "Avoid answering", "Assume understanding"),
        ("Resolution", "You cannot resolve a request within your authority. What next?", "Escalate with relevant context", "Promise an exception", "Close it as resolved", "Share it publicly"),
        ("Privacy", "Before discussing account-specific details, you should:", "Complete the approved identity checks", "Ask for the customer's password", "Skip checks for urgent calls", "Read details to anyone who calls"),
        ("Communication", "Which response sets a clear expectation?", "Explain the next step and confirmed follow-up process", "Guarantee an outcome you cannot control", "Say nothing can be done", "Give an invented deadline"),
        ("Resolution", "How should a recurring issue be handled?", "Document it and raise it through the improvement process", "Hide the pattern", "Delete earlier complaints", "Blame the customer"),
        ("Privacy", "Which information belongs in a routine case note?", "Only information needed to resolve the case", "Full passwords", "Unrelated personal details", "Private opinions about colleagues"),
        ("Communication", "Which actions support a clear customer conversation? Select all that apply.", ("Listen without interrupting", "Clarify the customer's concern"), "Promise an unverified deadline", "Ignore the question"),
        ("Resolution", "Before closing a case, what should you verify?", "The resolution and follow-up are accurately recorded", "The case count is high", "No one will review it", "The customer never contacts us again"),
    ],
    "T003": [
        ("Phishing", "An unexpected email requests your password. What should you do?", "Report it through the approved security channel", "Reply with the password", "Forward it to customers", "Click every link"),
        ("Access", "How should you protect a work account?", "Use approved authentication and keep credentials private", "Share credentials with the team", "Use a public password list", "Disable all security checks"),
        ("Data safety", "You receive a suspicious attachment. What is appropriate?", "Avoid opening it and report it", "Run it to see what happens", "Upload it to an open group", "Disable protection first"),
        ("Access", "You leave your workstation briefly. What should you do?", "Lock the screen", "Leave customer files open", "Give someone your password", "Turn off audit logging"),
        ("Phishing", "Which detail can indicate a suspicious link?", "An unexpected destination or misleading domain", "A familiar topic alone", "A short message alone", "A weekday delivery"),
        ("Data safety", "Where should work documents be stored?", "In approved work storage", "On any public sharing site", "In a personal social account", "On an unknown USB drive"),
        ("Access", "An unknown caller asks for a one-time code. What should you do?", "Do not share it and follow reporting guidance", "Read it aloud", "Send a screenshot", "Approve every prompt"),
        ("Phishing", "A message creates urgency to bypass a normal process. What next?", "Verify using a known trusted channel", "Follow it immediately", "Share account details", "Ignore all future messages"),
        ("Data safety", "You suspect that work data was exposed. What should you do?", "Report promptly using the incident process", "Delete all evidence", "Wait indefinitely", "Discuss details publicly"),
        ("Access", "Why are individual accounts useful?", "They support appropriate access and accountability", "They allow passwords to be shared", "They remove the need for permissions", "They guarantee no mistakes"),
    ],
}

# Question position (1-based) whose type is not plain single choice. Same variety as the prototype.
SPECIAL_TYPES = {("T001", 9): "TRUE_FALSE", ("T002", 9): "MCQ_MULTIPLE", ("T003", 9): "SCENARIO"}

# name, training code or None, function code or None, [(competency, prompt)]
BEHAVIOUR_TEMPLATES = [
    ("KYC & AML in daily work", "T001", None, [
        ("Applies the documented process", "How consistently do you follow the documented verification process in daily cases?"),
        ("Recognises and escalates exceptions", "When a case falls outside the normal process, how reliably is it escalated with context?"),
    ]),
    ("Compliance: KYC procedure adherence", "T001", "COMPLIANCE", [
        ("KYC procedure adherence", "How consistently is each KYC step completed and recorded before a case closes?"),
        ("Recognises and escalates exceptions", "How reliably are risk indicators raised through the approved channel?"),
    ]),
    ("Customer Handling in daily work", "T002", None, [
        ("Customer communication", "How clearly are customer conversations handled, including listening and checking understanding?"),
        ("Complaint handling and resolution", "How effectively are complaints resolved and recorded?"),
    ]),
    ("Customer Support: complaint handling", None, "SUPPORT", [
        ("Complaint handling and resolution", "How reliably are complaints acknowledged, resolved and followed up?"),
        ("Customer communication", "How well is the next step explained to the customer?"),
    ]),
    ("Sales: customer communication and product explanation", None, "SALES", [
        ("Customer communication", "How clearly are products explained in plain language without unverified promises?"),
    ]),
    ("Operations: process accuracy and discipline", None, "OPERATIONS", [
        ("Process accuracy and discipline", "How consistently are operational steps completed correctly and on time?"),
    ]),
    ("Technology: security practices and development discipline", None, "TECH", [
        ("Security practices", "How consistently are approved security practices followed in daily work?"),
    ]),
    ("Cybersecurity in daily work", "T003", None, [
        ("Security practices", "How consistently do you apply approved account and data security practices?"),
        ("Recognises and escalates exceptions", "How promptly are suspicious events reported through the incident process?"),
    ]),
]

EXAMPLE_TEXT = "Sample synthetic example: followed the documented steps on a routine case and recorded the outcome."
