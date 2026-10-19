from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from accounts.models import User
from publishing.models import Comment, Paper, Review
from publishing.services import decide, propose, publish


class Command(BaseCommand):
    help = (
        "Create clearly labelled local demonstration content, without login-capable demo accounts."
    )

    def handle(self, **options):
        if not settings.DEBUG:
            raise CommandError("Demo seeding is only available in DEBUG mode.")
        if Paper.objects.exists():
            self.stdout.write("Existing papers found; no demonstration data added.")
            return
        users = []
        for username in ("demo_researcher", "demo_contributor", "demo_reviewer"):
            user, _ = User.objects.get_or_create(
                username=username,
                defaults={"email": f"{username}@example.invalid", "email_verified": True},
            )
            user.set_unusable_password()
            user.save()
            from publishing.models import AgreementAcceptance
            from publishing.licensing import VERSION, document_hash

            AgreementAcceptance.objects.get_or_create(
                user=user, version=VERSION, defaults={"document_hash": document_hash()}
            )
            users.append(user)
        author, contributor, reviewer = users
        examples = [
            (
                "A short note on gradient descent",
                "Alex Chen\nJordan Lee",
                "An illustrative note on the simplest convergence guarantee for gradient descent on a smooth convex objective.",
                "# A short note on gradient descent\n\n*Demonstration document — not a research publication.*\n\n## Setup\n\nLet $f: \\mathbb{R}^d \\to \\mathbb{R}$ be convex with an $L$-Lipschitz gradient. We consider the update\n\n$$\nx_{t+1} = x_t - \\eta \\nabla f(x_t).\n$$\n\n## A descent inequality\n\nSmoothness gives\n\n$$\nf(x_{t+1}) \\leq f(x_t) - \\eta (1 - L\\eta/2)\\|\\nabla f(x_t)\\|^2.\n$$\n\nFor $0 < \\eta \\leq 1/L$, each step decreases the objective unless the gradient vanishes.\n\n## Discussion\n\nThis is a small example of a note that can develop through independently credited corrections and improvements.\n\n## References\n\n1. Standard introductory treatments of convex optimization.\n",
            ),
            (
                "Reproducibility begins with the experimental record",
                "Sam Rivera",
                "A demonstration checklist for preserving assumptions, parameters, and intermediate results alongside a research note.",
                "# Reproducibility begins with the experimental record\n\n*Demonstration document — not a research publication.*\n\n## A minimal record\n\nA useful experimental record states the question, the assumptions, and the procedure.\n\n1. Record the input data and its origin.\n2. Write down every parameter that affects the result.\n3. Preserve both successful and unsuccessful runs.\n\n## Reporting uncertainty\n\nReport the number of observations $n$ alongside the sample mean\n\n$$\n\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n}x_i.\n$$\n\nThe record should make it possible for another researcher to reproduce the calculation.\n",
            ),
            (
                "A reading note on conditional probability",
                "Morgan Park\nAlex Chen",
                "An introductory demonstration of conditional probability, with a distinction between an event and a hypothesis.",
                "# A reading note on conditional probability\n\n*Demonstration document — not a research publication.*\n\n## Definition\n\nFor events $A$ and $B$ with $P(B)>0$,\n\n$$\nP(A \\mid B) = \\frac{P(A \\cap B)}{P(B)}.\n$$\n\n## Interpretation\n\nConditioning restricts the space of possibilities. It does not by itself establish a causal relationship.\n\n> A probability statement is meaningful only after its conditioning information is clear.\n",
            ),
        ]
        for i, (title, authors, abstract, markdown) in enumerate(examples):
            category = ("math.OC", "cs.DL", "math.PR")[i]
            paper = publish(
                author,
                {
                    "license": "CC-BY-4.0",
                    "primary_category": category,
                    "secondary_categories": [],
                    "title": title,
                    "authors": authors,
                    "abstract": abstract,
                    "markdown": markdown,
                    "explanation": "Initial demonstration publication.",
                },
            )
            Review.objects.create(
                paper=paper,
                user=reviewer,
                score=4 if i != 1 else 5,
                text="Demonstration review: the argument is readable and the assumptions are stated clearly. A worked example would make this note more useful.",
            )
            if i == 0:
                data = {
                    "license": "CC-BY-4.0",
                    "primary_category": category,
                    "secondary_categories": [],
                    "title": title,
                    "authors": authors,
                    "abstract": abstract,
                    "markdown": markdown
                    + "\n## A one-dimensional example\n\nFor $f(x)=x^2/2$ and $\\eta=1/2$, the iterates satisfy $x_{t+1}=x_t/2$.\n",
                    "explanation": "Add a one-dimensional worked example.",
                }
                accepted = propose(contributor, paper.pk, paper.current_id, data)
                decide(author, accepted.pk, "accepted")
                paper.refresh_from_db()
                data["markdown"] += (
                    "\nThe objective therefore decreases by a factor of four at each step.\n"
                )
                data["explanation"] = "Make the objective decrease explicit in the example."
                pending = propose(contributor, paper.pk, paper.current_id, data)
                Comment.objects.create(
                    submission=pending,
                    user=reviewer,
                    text="Demonstration comment: this makes the example easier to check against the general inequality.",
                )
        self.stdout.write(
            self.style.SUCCESS(
                "Created 3 demonstration papers with reviews, history, and a pending submission. Demo accounts cannot sign in."
            )
        )
