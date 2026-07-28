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

admin    = upsert(ADMIN, 'Ada', 'Admin', %w[Admin Agent], password: PASSWORD)
agent    = upsert(AGENT, 'Mira', 'Mentioned', %w[Agent])
customer = upsert(CUSTOMER, 'Carl', 'Customer', %w[Customer])

Setting.set('product_name', 'Zammad Integration')
# Without this Zammad keeps answering as if setup were still pending.
Setting.set('system_init_done', true)

puts "admin=#{admin.id} agent=#{agent.id} customer=#{customer.id} groups=#{Group.count}"
