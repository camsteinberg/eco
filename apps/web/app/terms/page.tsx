// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Metadata } from "next";
import Link from "next/link";
import { use } from "react";
import { EcoLogo } from "../../src/components/EcoLogo";
import { PublicFooter } from "../../src/components/public/PublicFooter";
import { PublicNav } from "../../src/components/public/PublicNav";
import { resolvePublicAppDestination } from "../../src/lib/access-policy";
import { isBillingUiEnabled } from "../../src/lib/billing-ui-gate";
import { resolveReturnTo } from "../../src/lib/navigation-return";

type SearchParamValue = string | string[] | undefined;

function getFirstSearchParam(value: SearchParamValue): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return null;
}

export const metadata: Metadata = {
  title: "Terms of Service — Eco",
  description:
    "Terms of Service for Eco web v1.0: on-device, browser-local AI chat.",
};

export default function TermsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, SearchParamValue>>;
}) {
  const resolvedSearchParams = searchParams ? use(searchParams) : undefined;
  const requestedReturnTo = getFirstSearchParam(resolvedSearchParams?.returnTo);
  const returnTo = requestedReturnTo ? resolveReturnTo(requestedReturnTo, "/") : null;
  const appHref = resolvePublicAppDestination(requestedReturnTo);

  return (
    <div className="grain relative min-h-dvh overflow-x-hidden bg-[var(--eco-surface)]">
      {/* Soft glow */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div
          className="absolute left-1/2 top-0 h-[400px] w-[600px] -translate-x-1/2 rounded-full opacity-[0.06] blur-[100px]"
          style={{ backgroundColor: "var(--eco-primary)" }}
        />
      </div>

      <div className="relative z-10">
        <PublicNav />

        {returnTo && (
          <div className="mx-auto max-w-3xl px-6 pt-6">
            <Link
              href={returnTo}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-4 py-2 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)]"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
              </svg>
              Back to app
            </Link>
          </div>
        )}

        <main className="mx-auto max-w-3xl min-w-0 px-4 py-16 sm:px-6 sm:py-24">
          {/* Header */}
          <div className="mb-12 flex flex-col items-center gap-6">
            <Link href={appHref} aria-label="Go to chat" className="inline-flex min-h-11 min-w-11 items-center justify-center">
              <EcoLogo size="md" />
            </Link>
            <h1 className="font-serif font-medium tracking-tight text-[var(--eco-text)]" style={{ fontSize: 'clamp(2rem, 1rem + 5vw, 3rem)' }}>
              Terms of Service
            </h1>
            <p className="text-base text-[var(--eco-text-secondary)]">
              Last updated: June 3, 2026
            </p>
          </div>

        {/* Content */}
        <article className="min-w-0 space-y-10 text-base leading-relaxed text-[var(--eco-text-secondary)] [overflow-wrap:anywhere]">
          {/* 1. Acceptance of Terms */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              1. Acceptance of Terms
            </h2>
            <p>
              By accessing or using the Eco website, app, or any associated
              services (collectively, the
              &ldquo;Service&rdquo;), operated by Bos Computing LLC
              (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;), you
              agree to be bound by these Terms of Service (&ldquo;Terms&rdquo;).
              If you do not agree, please do not use the Service. Your continued
              use after any updates to these Terms constitutes acceptance of the
              revised Terms.
            </p>
          </section>

          {/* 2. Eligibility */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              2. Eligibility
            </h2>
            <p className="mb-3">
              You must be at least 13 years of age to use the Service. If you
              are between 13 and 18 years of age (or the age of majority in your
              jurisdiction), you may only use the Service with the consent of a
              parent or legal guardian who agrees to be bound by these Terms. If
              you are located in the European Economic Area, you must be at least
              16 years of age to use the Service without parental consent.
            </p>
            <p>
              By using the Service, you represent and warrant that you meet
              these eligibility requirements and have the legal capacity to enter
              into these Terms.
            </p>
          </section>

          {/* 3. Description of Service */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              3. Description of Service
            </h2>
            <p className="mb-3">
              Eco web v1.0 is a local-first AI service. The AI model runs
              on your device, inside your browser &mdash; your conversations are
              not sent to Eco servers for inference. Eco provides text and
              code generation only &mdash; no image, audio, or video generation.
            </p>
            <p className="mb-3">
              Browser-local AI depends on your browser, device memory, storage
              APIs, and model readiness checks. Eco may limit, block, or ask you
              to retest local setup when a browser profile cannot safely run a
              model. Preparing a local model downloads model artifacts to your
              browser; these downloads are separate from your chat prompts, which
              stay on your device during inference.
            </p>
            <p>
              Certain features of the Service may be designated as beta,
              experimental, or &ldquo;coming soon.&rdquo; These features are
              provided as-is, may change or be discontinued without notice, and
              may not function as described. Your use of beta features is at your
              own risk.
            </p>
          </section>

          {/* 4. User Accounts */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              4. User Accounts
            </h2>
            <p>
              You are responsible for maintaining the confidentiality of your
              account credentials. You are responsible for all
              activity that occurs under your account, whether or not you
              authorized it. Notify us immediately at{" "}
              <a
                href="mailto:support@econetwork.ai"
                className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                style={{ color: "var(--eco-primary)" }}
              >
                support@econetwork.ai
              </a>{" "}
              if you suspect unauthorized access.
            </p>
          </section>

          {/* 5. Acceptable Use */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              5. Acceptable Use
            </h2>
            <p className="mb-3">You agree not to:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>Use the Service to generate illegal, harmful, or abusive content</li>
              <li>Attempt to circumvent rate limits or access controls</li>
              <li>Reverse-engineer, attack, or disrupt the Service or its infrastructure</li>
              <li>Use the Service to develop competing AI services by scraping outputs at scale</li>
              <li>Impersonate other users or misrepresent your identity</li>
              <li>Submit queries intended to extract model weights or training data</li>
              <li>Use the Service in any manner that violates applicable local, state, national, or international law</li>
              <li>Transmit malware, viruses, or other harmful code through the Service</li>
              <li>Use automated means (bots, scrapers, or headless browsers) to access or overload the Service in ways these Terms prohibit</li>
            </ul>
            <p className="mt-3">
              We reserve the right to suspend or terminate accounts that violate
              these Terms without prior notice. Repeated or severe violations may
              result in permanent account termination.
            </p>
          </section>

          {/* 6. Intellectual Property and AI Outputs */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              6. Intellectual Property and AI Outputs
            </h2>
            <p className="mb-3">
              <strong className="text-[var(--eco-text)]">
                Your inputs:
              </strong>{" "}
              You retain all rights to the content you submit to the Service.
              You grant us a limited, non-exclusive license to process your
              inputs solely for the purpose of providing and improving the
              Service. We do not use your inputs to train AI models.
            </p>
            <p className="mb-3">
              <strong className="text-[var(--eco-text)]">
                AI-generated outputs:
              </strong>{" "}
              Subject to these Terms and applicable law, we assign to you all
              of our right, title, and interest (if any) in AI-generated
              outputs produced in response to your inputs. You may use
              these outputs for any lawful purpose, including commercial use.
            </p>
            <p className="mb-3">
              <strong className="text-[var(--eco-text)]">
                No warranties on outputs:
              </strong>{" "}
              AI-generated outputs may be inaccurate, incomplete, or
              non-original. We make no representations or warranties regarding
              the accuracy, originality, non-infringement, or fitness for any
              purpose of AI-generated outputs. You are solely responsible for
              evaluating and using outputs, including verifying their accuracy
              and ensuring they do not infringe third-party rights.
            </p>
            <p>
              <strong className="text-[var(--eco-text)]">
                Eco&apos;s intellectual property:
              </strong>{" "}
              The Eco name, logo, software, website design, and documentation
              are the property of Bos Computing LLC or its licensors. The Eco
              software is licensed under the AGPL-3.0 as described in Section
              7 below. Nothing in these Terms grants you rights to our
              trademarks or branding except as required for reasonable use of
              the Service.
            </p>
          </section>

          {/* 7. Open Source License */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              7. Open Source License
            </h2>
            <p>
              The Eco software is released under the{" "}
              <strong className="text-[var(--eco-text)]">
                GNU Affero General Public License v3.0 (AGPL-3.0)
              </strong>
              . The full source code is publicly available. You may use, modify,
              and redistribute the software in accordance with the license terms.
              If you run a modified version of Eco as a network service, you must
              make your modifications available to users of that service under the
              same license.
            </p>
          </section>

          {/* 8. Subscription Billing — hidden when billing UI is disabled */}
          {isBillingUiEnabled() && (
            <section>
              <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
                8. Subscription Billing
              </h2>
              <p>
                Eco is free to use, and the free tier includes the complete product
                &mdash; no locked features, no usage limits. Supporter is an
                optional $15/month membership that unlocks nothing extra; it simply
                helps keep Eco independent. Payments are processed through Stripe and
                billed monthly. You can cancel anytime from the billing portal in
                your account settings; cancellation takes effect at the end of the
                billing period, and your access to Eco is the same whether or not
                you subscribe. Refunds are handled case by case &mdash; contact us
                if you believe a charge was made in error. We may change pricing
                with 30 days&apos; notice.
              </p>
            </section>
          )}

          {/* 9. Data Handling */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              9. Data Handling
            </h2>
            <p>
              In Eco web v1.0, the AI model runs on your device, inside your
              browser. Your conversations are not sent to Eco servers for
              inference. Conversations can persist locally in your browser
              storage if you keep them, and you can clear them at any time. We
              still process account, billing, and operational data to run the
              Service. For full details on data collection, processing,
              retention, and your rights, please see our{" "}
              <Link
                href="/privacy"
                className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                style={{ color: "var(--eco-primary)" }}
              >
                Privacy Policy
              </Link>
              , which is incorporated into these Terms by reference.
            </p>
          </section>

          {/* 10. Disclaimer of Warranties */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              10. Disclaimer of Warranties
            </h2>
            <p>
              THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
              AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS
              OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF
              MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
              NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
              UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF HARMFUL COMPONENTS.
              AI-GENERATED OUTPUTS MAY BE INACCURATE, INCOMPLETE, OR BIASED
              &mdash; ALWAYS VERIFY IMPORTANT INFORMATION INDEPENDENTLY.
              BECAUSE THE AI MODEL RUNS ON YOUR OWN DEVICE, THE QUALITY,
              SPEED, AND AVAILABILITY OF ON-DEVICE AI DEPEND ON YOUR BROWSER,
              HARDWARE, AND AVAILABLE RESOURCES, WHICH WE DO NOT CONTROL.
            </p>
          </section>

          {/* 11. Limitation of Liability */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              11. Limitation of Liability
            </h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, BOS COMPUTING
              LLC AND ITS OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, AND
              CONTRIBUTORS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
              SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING LOSS OF
              PROFITS, DATA, GOODWILL, OR BUSINESS OPPORTUNITY, ARISING OUT OF
              OR IN CONNECTION WITH YOUR USE OF THE SERVICE, WHETHER BASED ON
              WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE), OR ANY OTHER LEGAL
              THEORY, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH
              DAMAGES. OUR TOTAL AGGREGATE LIABILITY FOR ANY CLAIM SHALL NOT
              EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US IN THE TWELVE (12)
              MONTHS PRECEDING THE CLAIM OR (B) ONE HUNDRED U.S. DOLLARS ($100).
            </p>
          </section>

          {/* 12. Indemnification */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              12. Indemnification
            </h2>
            <p>
              You agree to indemnify, defend, and hold harmless Bos Computing
              LLC, its officers, directors, employees, agents, and contributors
              from and against any and all claims, damages, losses, liabilities,
              costs, and expenses (including reasonable attorneys&apos; fees)
              arising out of or related to: (a) your use of the Service; (b)
              your violation of these Terms; (c) your violation of any
              applicable law or regulation; (d) your violation of any
              third-party rights, including intellectual property rights; or
              (e) any content you submit to or generate through the Service. We
              will provide you with reasonable notice of any such claim and
              cooperate with your defense at your expense.
            </p>
          </section>

          {/* 13. Force Majeure */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              13. Force Majeure
            </h2>
            <p>
              Neither party shall be liable for any failure or delay in
              performing its obligations under these Terms to the extent that
              such failure or delay results from circumstances beyond its
              reasonable control, including but not limited to: natural
              disasters, acts of war or terrorism, pandemics, government
              actions, power or internet outages, or failures of
              third-party infrastructure providers. During a force majeure
              event, the affected party&apos;s obligations are suspended for
              the duration of the event.
            </p>
          </section>

          {/* 14. Export Controls and Sanctions */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              14. Export Controls and Sanctions
            </h2>
            <p>
              The Service may be subject to export control and sanctions laws of
              the United States and other jurisdictions. You represent and
              warrant that: (a) you are not located in, or a resident or
              national of, any country subject to comprehensive U.S. trade
              sanctions (currently Cuba, Iran, North Korea, Syria, and the
              Crimea, Donetsk, and Luhansk regions); (b) you are not listed on
              any U.S. government list of prohibited or restricted parties; and
              (c) you will not use the Service in violation of any applicable
              export control or sanctions laws.
            </p>
          </section>

          {/* 15. Modifications to Terms */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              15. Modifications to Terms
            </h2>
            <p>
              We may update these Terms from time to time. We will provide at
              least 30 days&apos; notice of material changes by posting the
              updated Terms on this page, updating the &ldquo;Last
              updated&rdquo; date, and, where feasible, notifying you by email.
              Your continued use of the Service after the notice period
              constitutes acceptance of the revised Terms. If you do not agree
              to the updated Terms, you must stop using the Service.
            </p>
          </section>

          {/* 16. Governing Law and Dispute Resolution */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              16. Governing Law and Dispute Resolution
            </h2>
            <p className="mb-3">
              These Terms shall be governed by and construed in accordance with
              the laws of the State of Wyoming, without regard to its conflict of
              law provisions.
            </p>
            <p className="mb-3">
              Any dispute arising from these Terms or the Service shall be
              resolved through good-faith negotiation first. If negotiation
              fails within 30 days, the dispute shall be resolved through
              binding arbitration administered by the American Arbitration
              Association (AAA) under its Commercial Arbitration Rules.
              Arbitration shall take place in the State of Wyoming or, at the
              claimant&apos;s election, via videoconference. The arbitrator&apos;s
              decision shall be final and binding and may be entered as a
              judgment in any court of competent jurisdiction.
            </p>
            <p className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-4 text-[var(--eco-text)]">
              <strong>Class Action Waiver:</strong> You agree that any dispute
              resolution proceedings will be conducted only on an individual
              basis and not in a class, consolidated, or representative action.
              You waive any right to participate in a class action lawsuit or
              class-wide arbitration against Bos Computing LLC. If this waiver
              is found unenforceable, the entire arbitration agreement shall be
              void (but the remaining Terms shall survive).
            </p>
          </section>

          {/* 17. General Provisions */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              17. General Provisions
            </h2>
            <ul className="list-disc space-y-3 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">
                  Entire Agreement.
                </strong>{" "}
                These Terms, together with the Privacy Policy and any
                subscription agreement, constitute the entire agreement between
                you and Bos Computing LLC regarding the Service and supersede
                all prior agreements, communications, and understandings.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Severability.
                </strong>{" "}
                If any provision of these Terms is held to be invalid,
                unenforceable, or illegal by a court of competent jurisdiction,
                the remaining provisions shall continue in full force and
                effect. The invalid provision shall be modified to the minimum
                extent necessary to make it valid and enforceable.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Waiver.
                </strong>{" "}
                Our failure to enforce any right or provision of these Terms
                shall not constitute a waiver of such right or provision. Any
                waiver must be in writing and signed by an authorized
                representative of Bos Computing LLC.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Assignment.
                </strong>{" "}
                You may not assign or transfer your rights or obligations under
                these Terms without our prior written consent. We may assign
                our rights and obligations in connection with a merger,
                acquisition, reorganization, or sale of all or substantially
                all of our assets, provided the assignee agrees to be bound by
                these Terms.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Notices.
                </strong>{" "}
                We may provide notices to you via email to the address
                associated with your account or by posting on the Service.
                Notices to us should be sent to{" "}
                <a
                  href="mailto:support@econetwork.ai"
                  className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                  style={{ color: "var(--eco-primary)" }}
                >
                  support@econetwork.ai
                </a>
                .
              </li>
            </ul>
          </section>

          {/* 18. Contact */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              18. Contact
            </h2>
            <p>
              If you have questions about these Terms, please contact us at{" "}
              <a
                href="mailto:support@econetwork.ai"
                className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                style={{ color: "var(--eco-primary)" }}
              >
                support@econetwork.ai
              </a>
              .
            </p>
            <p className="mt-3">
              Bos Computing LLC
              <br />
              Wyoming, United States
            </p>
          </section>
        </article>

        </main>

        <PublicFooter />
      </div>
    </div>
  );
}
