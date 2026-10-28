export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Sends account emails. The first implementation only logs; SMTP or an email API come later. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Writes mails to the server log, for an admin to forward by hand. */
export function logMailer(log: (line: string) => void = console.log): Mailer {
  return {
    async send(mail) {
      log(`via443 mail to ${mail.to}: ${mail.subject}\n${mail.text}`);
    },
  };
}
