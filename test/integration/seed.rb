# Brings a fresh Zammad into a usable state for the integration suite.
#
# This replaces AUTOWIZARD_JSON, which cannot work in a split-container setup:
# the entrypoint writes tmp/auto_wizard.json inside the *init* container, and
# nothing shares that path with the rails server that would have to read it. The
# payload is accepted, logged as "saved", and then quietly never applied.
#
# Everything the tests need is created here rather than over the API, because
# the interesting failures are permission-shaped: an admin role alone does not
# grant access to a group, so ticket creation comes back 403 with nothing to
# suggest that group access is what is missing.

ADMIN    = 'admin@example.test'
AGENT    = 'mira@example.test'
CUSTOMER = 'customer@example.test'
PASSWORD = 'IntegrationT3st!'

UserInfo.current_user_id = 1

# Full access to every group, so neither ticket creation nor reading a mention
# depends on which group a test happened to land in.
def full_access
  Group.all.each_with_object({}) { |group, map| map[group.id] = ['full'] }
end

def upsert(email, firstname, lastname, roles, password: nil)
  user = User.find_by(email: email)
  attributes = {
    login:     email,
    firstname: firstname,
    lastname:  lastname,
    email:     email,
    active:    true,
    role_ids:  Role.where(name: roles).pluck(:id),
  }
  attributes[:password] = password if password

  if user
    user.update!(attributes)
  else
    user = User.create!(attributes)
    puts "created #{email}"
  end

  # Customers have no group access; granting it would raise.
  unless roles == ['Customer']
    user.group_ids_access_map = full_access
    user.save!
  end

  user
end

# A second group carrying a signature of its own.
#
# Created before the users, so full_access covers it. Without a second
# signature no test could tell *which* group a signature came from, and the
# placeholders below would have to be written by editing Zammad's stock
# signature — a mutation that leaves the instance wrong if a run dies partway.
ESCALATION_SIGNATURE = 'Escalations desk — Re #{ticket.number}: #{ticket.title} (#{ticket.group.name})'.freeze

escalations = Group.find_by(name: 'Escalations') || Group.create!(name: 'Escalations', active: true)
# Two groups that must *not* produce a signature: one with none configured, one
# pointing at a signature an admin has switched off. Both are states a real
# instance sits in, and both have to leave the article exactly as it was written.
unsigned = Group.find_by(name: 'Unsigned') || Group.create!(name: 'Unsigned', active: true)
retired  = Group.find_by(name: 'Retired') || Group.create!(name: 'Retired', active: true)
# A signature that is markup only: non-empty as a template, and empty once
# rendered. It is the more interesting of the two empty cases — a body of ''
# never gets past findForGroup, while this one reaches the renderer. (A *dangling* signature_id is deliberately not seeded — it
# cannot exist. groups.signature_id carries a foreign key, so Postgres refuses
# one; the guard against it in findForGroup is belt and braces, not a real case.)
blank = Group.find_by(name: 'Blank') || Group.create!(name: 'Blank', active: true)

admin    = upsert(ADMIN, 'Ada', 'Admin', %w[Admin Agent], password: PASSWORD)
agent    = upsert(AGENT, 'Mira', 'Mentioned', %w[Agent])
customer = upsert(CUSTOMER, 'Carl', 'Customer', %w[Customer])

# Outbound email needs a sender address on the group. Without one Zammad rejects
# an email article with "This group has no email address configured for outgoing
# communication.", and the signature tests never reach the code they are about.
#
# Nothing can actually leave: the address hangs off the stock notification
# channel, whose SMTP host is the reserved host.example.com, and the suite only
# ever writes to .test recipients.
channel = Channel.find_by(area: 'Email::Notification')
address = EmailAddress.find_by(email: 'helpdesk@example.test') || EmailAddress.create!(
  name:       'Zammad Integration',
  email:      'helpdesk@example.test',
  channel_id: channel&.id,
  active:     true,
)
Group.find_by(name: 'Users').update!(email_address_id: address.id)

# Rewritten on every run rather than only on create, so the fixture is the same
# whatever state a previous run left behind.
signature = Signature.find_by(name: 'Escalations') || Signature.create!(name: 'Escalations', body: '')
signature.update!(body: ESCALATION_SIGNATURE, active: true)
escalations.update!(signature_id: signature.id, email_address_id: address.id)

inactive = Signature.find_by(name: 'Retired') || Signature.create!(name: 'Retired', body: '')
inactive.update!(body: 'Retired team — should never be sent', active: false)
retired.update!(signature_id: inactive.id, email_address_id: address.id)

unsigned.update!(signature_id: nil, email_address_id: address.id)

empty = Signature.find_by(name: 'Blank') || Signature.create!(name: 'Blank', body: '')
empty.update!(body: '<br><br>', active: true)
blank.update!(signature_id: empty.id, email_address_id: address.id)

Setting.set('product_name', 'Zammad Integration')
# Without this Zammad keeps answering as if setup were still pending.
Setting.set('system_init_done', true)

puts "admin=#{admin.id} agent=#{agent.id} customer=#{customer.id} groups=#{Group.count}"
