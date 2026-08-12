import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_twilio_ivr_key';

// Admin Login
export const login = async (req, res) => {
    const { email, password } = req.body;

    // Validate email format
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    try {
      // Find admin by email
      const { data: admin, error } = await supabase
        .from('admins')
        .select('*')
        .eq('email', email.toLowerCase())
        .maybeSingle();

      if (error || !admin) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      // Verify password hash
      const isMatch = await bcrypt.compare(password, admin.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      // Sign JWT token
      const token = jwt.sign(
        { id: admin.id, email: admin.email, role: admin.role },
        JWT_SECRET,
        { expiresIn: '24h' } // Token valid for 24 hours
      );

      return res.status(200).json({
        message: 'Login successful.',
        token,
        admin: {
          email: admin.email,
          role: admin.role
        }
      });
    } catch (err) {
      console.error('Error during admin login:', err);
      return res.status(500).json({ error: 'Internal server error during authentication.' });
    }
  };

// Admin Registration/Add (Optional helper)
export const register = async (req, res) => {
    const { email, password, role } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    try {
      // Check if email already registered
      const { data: existingAdmin } = await supabase
        .from('admins')
        .select('id')
        .eq('email', email.toLowerCase())
        .maybeSingle();

      if (existingAdmin) {
        return res.status(400).json({ error: 'Admin email is already registered.' });
      }

      // Hash password
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      // Create new admin
      const { data: newAdmin, error } = await supabase
        .from('admins')
        .insert({
          email: email.toLowerCase(),
          password_hash: passwordHash,
          role: role || 'admin'
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return res.status(201).json({
        message: 'Admin account created successfully.',
        admin: {
          email: newAdmin.email,
          role: newAdmin.role
        }
      });
    } catch (err) {
      console.error('Error creating admin account:', err);
      return res.status(500).json({ error: 'Failed to register admin account.' });
    }
  };
